import * as path from 'path';
import {
  askForInput,
  confirm,
  logError,
  logInfo,
  pickOne,
  run
} from './utils';

export default async () => {
  const cloudProviders = ['minikube', 'gcp'];
  const question = 'Which cloud provider are you hosting with';
  const provider = await pickOne(question, cloudProviders);
  switch (provider) {
    case 'minikube': {
      logInfo('Note: Minikube is for development purposes only.');

      // Start minikube if it isn't running
      try {
        await run('minikube status');
      } catch (error) {
        logInfo('Starting Minikube. This may take a minute.');
        await run('minikube start');
      }

      await run('minikube addons enable ingress');
      await run('helm init --wait');

      const { stdout: minikubeIP } = await run('minikube ip');

      // Install traefik
      await run(`
        helm install stable/traefik \
        --name traefik \
        --namespace kube-system \
        --set serviceType=NodePort \
        --set dashboard.enabled=true \
        --set dashboard.domain=traefik-ui.minikube
      `);
      const traefikHost = `${minikubeIP} traefik-ui.minikube`;
      logInfo(
        `Add "${traefikHost}" to your hosts file to access traefik's dashboard.`
      );

      // Install docker registry
      await run('helm install stable/docker-registry --name docker-registry');

      if (await confirm('Install an example app on Minikube')) {
        const deployFile = path.resolve(
          __dirname,
          '../config/deployment-minikube.yaml'
        );
        await run(`kubectl apply -f ${deployFile}`);
        const whoAmIHost = `${minikubeIP} whoami.minikube`;
        logInfo(
          `Add "${whoAmIHost}" to your hosts file to access example app.`
        );
      }

      const completeMsg =
        'Creation complete. It may take a few minutes for services to become available.';
      logInfo(completeMsg);
      break;
    }
    case 'gcp': {
      // Check if we need to authenticate.
      try {
        const { stdout } = await run('gcloud auth list');
        const isAuthenticated = stdout.indexOf('*') > -1;
        if (!isAuthenticated) {
          await run('gcloud auth login');
        }
      } catch (error) {
        await run('gcloud auth login');
      }

      const { stdout: projectId } = await run(
        'gcloud config get-value project'
      );
      await run('gcloud services enable container.googleapis.com');

      // Check if we have an existing cluster
      let clusterExists = false;
      const { stdout: clusterData } = await run(
        'gcloud container clusters list'
      );
      if (clusterData.indexOf('snow-cluster') > -1) {
        clusterExists = true;
      }

      const createClusterCmd = `
        gcloud beta container \
          clusters create "snow-cluster" \
          --zone "us-west1-b" \
          --no-enable-basic-auth \
          --cluster-version "1.11.5-gke.5" \
          --image-type "COS" \
          --machine-type "f1-micro" \
          --disk-type "pd-standard" \
          --disk-size "10" \
          --default-max-pods-per-node "110" \
          --num-nodes "3" \
          --enable-cloud-logging \
          --enable-cloud-monitoring \
          --enable-ip-alias \
          --network "projects/${projectId}/global/networks/default" \
          --subnetwork "projects/${projectId}/regions/us-west1/subnetworks/default" \
          --default-max-pods-per-node "110" \
          --addons HorizontalPodAutoscaling,HttpLoadBalancing \
          --enable-autoupgrade \
          --enable-autorepair \
          --scopes "https://www.googleapis.com/auth/devstorage.read_only","https://www.googleapis.com/auth/logging.write","https://www.googleapis.com/auth/monitoring","https://www.googleapis.com/auth/service.management.readonly","https://www.googleapis.com/auth/servicecontrol","https://www.googleapis.com/auth/trace.append" \
      `;

      if (!clusterExists) {
        await run(createClusterCmd);
      }

      /*
       * Install helm with TLS.
       * https://medium.com/google-cloud/install-secure-helm-in-gke-254d520061f7
       */

      const BYTES = 2048;

      // Create Certificate Authority
      await run(`openssl genrsa -out $(helm home)/ca.key.pem ${BYTES}`);
      const config = `
        [req]\\n
        req_extensions=v3_ca\\n
        distinguished_name=req_distinguished_name\\n
        [req_distinguished_name]\\n
        [ v3_ca ]\\n
        basicConstraints=critical,CA:TRUE\\n
        subjectKeyIdentifier=hash\\n
        authorityKeyIdentifier=keyid:always,issuer:always`;
      await run(
        `
        openssl req \\
          -config <(printf '${config}') \\
          -key $(helm home)/ca.key.pem \\
          -new \\
          -x509 \\
          -days 7300 \\
          -sha256 \\
          -out $(helm home)/ca.cert.pem \\
          -extensions v3_ca \\
          -subj "/C=US"`,
        { shell: '/bin/bash' }
      );

      // Create credentials for tiller (server)
      await run(`openssl genrsa -out $(helm home)/tiller.key.pem ${BYTES}`);
      await run(
        `
        openssl req \
          -new \
          -sha256 \
          -key $(helm home)/tiller.key.pem \
          -out $(helm home)/tiller.csr.pem \
          -subj "/C=US/O=Snow/CN=tiller-server"`,
        { shell: '/bin/bash' }
      );
      const tillerConfig = `
        [SAN]\\n
        subjectAltName=IP:127.0.0.1`;
      await run(
        `
        openssl x509 -req -days 365 \
          -CA $(helm home)/ca.cert.pem \
          -CAkey $(helm home)/ca.key.pem \
          -CAcreateserial \
          -in $(helm home)/tiller.csr.pem \
          -out $(helm home)/tiller.cert.pem \
          -extfile <(printf '${tillerConfig}') \
          -extensions SAN`,
        { shell: '/bin/bash' }
      );

      // Create credentials for helm (client)
      await run(`openssl genrsa -out $(helm home)/helm.key.pem ${BYTES}`);
      await run(`
        openssl req -new -sha256 \
          -key $(helm home)/helm.key.pem \
          -out $(helm home)/helm.csr.pem \
          -subj "/C=US"
      `);
      await run(`
        openssl x509 -req -days 365 \
          -CA $(helm home)/ca.cert.pem \
          -CAkey $(helm home)/ca.key.pem \
          -CAcreateserial \
          -in $(helm home)/helm.csr.pem \
          -out $(helm home)/helm.cert.pem
      `);

      // Create service account and clusterrolebinding
      await run(`kubectl create serviceaccount \
        --namespace kube-system tiller
      `);
      await run(`kubectl create clusterrolebinding \
        tiller-cluster-rule \
        --clusterrole=cluster-admin \
        --serviceaccount=kube-system:tiller
      `);

      // Install Helm w/ 'tiller' service account
      await run(`
        helm init \
          --debug \
          --tiller-tls \
          --tiller-tls-cert $(helm home)/tiller.cert.pem \
          --tiller-tls-key $(helm home)/tiller.key.pem \
          --tiller-tls-verify \
          --tls-ca-cert $(helm home)/ca.cert.pem \
          --service-account tiller \
          --wait
      `);

      // Verify helm installation
      await run(`
        helm ls --tls \
          --tls-ca-cert $(helm home)/ca.cert.pem \
          --tls-cert $(helm home)/helm.cert.pem \
          --tls-key $(helm home)/helm.key.pem
      `);

      /**
       *
       * To remove helm:
       *
       * helm reset
       *   --tls
       *   --tls-ca-cert $(helm home)/ca.cert.pem
       *   --tls-cert $(helm home)/helm.cert.pem
       *   --tls-key $(helm home)/helm.key.pem
       */

      // Install nginx ingress
      await run(`
        helm install stable/nginx-ingress \
          --tls \
          --tls-ca-cert $(helm home)/ca.cert.pem \
          --tls-cert $(helm home)/helm.cert.pem \
          --tls-key $(helm home)/helm.key.pem \
          --namespace kube-system \
          --name nginx-ingress \
          --set controller.ingressClass=nginx \
          --set rbac.create=true
      `);

      // Install cert-manager
      await run(`
        helm install stable/cert-manager \
          --tls \
          --tls-ca-cert $(helm home)/ca.cert.pem \
          --tls-cert $(helm home)/helm.cert.pem \
          --tls-key $(helm home)/helm.key.pem \
          --namespace kube-system \
          --name cert-manager \
          --set ingressShim.defaultIssuerName=letsencrypt-prod \
          --set ingressShim.defaultIssuerKind=ClusterIssuer
      `);

      let email = await askForInput(
        'Provide an email address for Let\'s Encrypt'
      );
      while (!(await confirm(`Confirm email: "${email}"`))) {
        email = await askForInput('Provide an email address for Let\'s Encrypt');
      }

      // Create cluster issuer
      await run(`
        cat <<EOF | kubectl create -f -
          {
            "apiVersion": "certmanager.k8s.io/v1alpha1",
            "kind": "ClusterIssuer",
            "metadata": {
              "name": "letsencrypt-prod"
            },
            "spec": {
              "acme": {
                "email": "${email}",
                "http01": {},
                "privateKeySecretRef": {
                  "name": "letsencrypt-prod"
                },
                "server": "https://acme-v02.api.letsencrypt.org/directory"
              }
            }
          }
        \nEOF`);

      // Create global ingress controller
      await run(`
      cat <<EOF | kubectl create -f -
        {
          "apiVersion": "extensions/v1beta1",
          "kind": "Ingress",
          "metadata": {
            "annotations": {
              "ingress.kubernetes.io/ssl-redirect": "true",
              "kubernetes.io/ingress.class": "nginx",
              "kubernetes.io/tls-acme": "true"
            },
            "name": "snow-ingress"
          },
          "spec": {
            "rules": [
              {
                "host": "snow.cluster"
              }
            ]
          }
        }
      \nEOF`);

      // Create persistent storage for docker registry
      await run(`
        cat <<EOF | kubectl create -f -
          {
            "kind": "PersistentVolumeClaim",
            "apiVersion": "v1",
            "metadata": {
              "name": "docker-registry-pvc"
            },
            "spec": {
              "accessModes": [
                "ReadWriteOnce"
              ],
              "volumeMode": "Filesystem",
              "resources": {
                "requests": {
                  "storage": "8Gi"
                }
              }
            }
          }
        \nEOF`);

      // Install docker registry
      await run(`
        helm install stable/docker-registry \
          --tls \
          --tls-ca-cert $(helm home)/ca.cert.pem \
          --tls-cert $(helm home)/helm.cert.pem \
          --tls-key $(helm home)/helm.key.pem \
          --namespace default \
          --name docker-registry \
          --set secrets.htpasswd='user:$2y$05$8nR6bYM2ZKR0tkmJ9KEVTeWVVk77sucXVwZQp2q49t6sR0Oip346C' \
          --set persistence.enabled=true \
          --set persistence.existingClaim='docker-registry-pvc'
      `);

      const {stdout: dockerIP} = await run('kubectl get service/docker-registry -o jsonpath={.spec.clusterIP}');

      // // Create secret/regcred to store registry credentials
      await run(`kubectl create secret docker-registry regcred --docker-server=${dockerIP}:5000 --docker-username=user --docker-password=password`);

      // // Create ConfigMap for credentials
      await run(`
        cat <<EOF | kubectl create -f -
          {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {
              "name": "docker-config"
            },
            "data": {
              "config.json": "{\\"auths\\":{\\"${dockerIP}:5000\\":{\\"username\\":\\"user\\",\\"password\\":\\"password\\"}}}"
            }
          }
        \nEOF
      `);

      break;
    }
    default: {
      logError('No valid cloud provider selected.');
    }
  }
};
