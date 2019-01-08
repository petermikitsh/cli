import * as path from 'path';
import {logError, readFile, run, stat} from './utils';

const wait = (ms: number): Promise<undefined> => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

export default async () => {
  // First: Verify we have a Dockerfile.
  const dockerFilePath = path.resolve(process.cwd(), 'Dockerfile');
  try {
    await stat(dockerFilePath);
  } catch (error) {
    const msg = `Error finding Dockerfile.\n${error.message}`;
    logError(msg);
    return;
  }

  // Second: Verify we have a now.json file.
  const nowFilePath = path.resolve(process.cwd(), 'now.json');
  let nowConfig;
  try {
    const nowFile = await readFile(nowFilePath);
    nowConfig = JSON.parse(nowFile.toString());
  } catch (error) {
    const msg = `Error reading now.json.\n${error.message}`;
    logError(msg);
    return;
  }
  const { name, files = [] } = nowConfig;
  if (!name) {
    logError('Specify a "name" in now.json');
    return;
  }

  // Create TAR file
  await run(`tar cvfz ./buildcontext.tar.gz ./Dockerfile ${files.join(' ')}`);

  // Get Docker Registry IP Address
  const {stdout: dockerIP} = await run('kubectl get service/docker-registry -o jsonpath={.spec.clusterIP}');

  // Init Kaniko
  await run(`
  cat <<EOF | kubectl create -f -
    {
      "apiVersion": "v1",
      "kind": "Pod",
      "metadata": {
        "name": "kaniko"
      },
      "spec": {
        "restartPolicy": "Never",
        "initContainers": [
          {
            "name": "kaniko-init",
            "image": "alpine",
            "args": [
              "sh",
              "-c",
              "while true; do sleep 1; if [ -f /tmp/complete ]; then break; fi done"
            ],
            "volumeMounts": [
              {
                "name": "empty-folder",
                "mountPath": "/kaniko/build-context"
              }
            ]
          }
        ],
        "containers": [
          {
            "name": "kaniko",
            "image": "gcr.io/kaniko-project/executor:latest",
            "args": [
              "--context=dir:///kaniko/build-context",
              "--destination=${dockerIP}:5000/${name}:latest",
              "--insecure"
            ],
            "volumeMounts": [
              {
                "name": "empty-folder",
                "mountPath": "/kaniko/build-context"
              },
              {
                "name": "docker-config",
                "mountPath": "/kaniko/.docker"
              }
            ]
          }
        ],
        "volumes": [
          {
            "name": "empty-folder",
            "emptyDir": {}
          },
          {
            "name": "docker-config",
            "secret": {
              "secretName": "regcred",
              "items": [
                {
                  "key": ".dockerconfigjson",
                  "path": "config.json"
                }
              ]
            }
          }
        ]
      }
    }
  \nEOF`);

  // Wait for available
  await run('kubectl wait pod/kaniko --for condition=PodScheduled --timeout=60s');
  await wait(10000);

  // Copy build context to 'kaniko-init' container
  await run('kubectl cp -c kaniko-init buildcontext.tar.gz kaniko:/tmp/buildcontext.tar.gz');

  // Untar the build on the 'kaniko-init' container
  await run('kubectl exec kaniko -c kaniko-init -- tar -zxf /tmp/buildcontext.tar.gz -C /kaniko/build-context');

  // Trigger initializtion container to finish, so kaniko can build and deploy to the docker registry
  await run('kubectl exec kaniko -c kaniko-init -- touch /tmp/complete');

  // Await for completion
  await run('kubectl wait --for=condition=succeeded pods/kaniko');

  // Clean up kaniko
  // await run('kubectl delete pod/kaniko');

  // Create or update a deployment.

  // Create or update a service.

  // Create or update the ingress resource.
};
