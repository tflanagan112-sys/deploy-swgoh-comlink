# Deploy Thrawn's Plan Comlink on Northflank

This repository is ready to deploy as a Northflank combined service.

## Create the service

1. In Northflank, create a new project on the free Sandbox plan.
2. Create a **Combined Service**.
3. Connect GitHub and select `tflanagan112-sys/deploy-swgoh-comlink`.
4. Select branch `main`.
5. Choose **Dockerfile** as the build type.
6. Dockerfile path: `/Dockerfile`.
7. Build context: repository root.
8. Use the free Sandbox compute option only.

## Runtime variables

Add these environment variables in Northflank:

- `APP_NAME=thrawns-plan`
- `PORT=3000`
- `ACCESS_KEY=<generate a long random value>`
- `SECRET_KEY=<generate a different long random value>`

Do not commit real ACCESS_KEY or SECRET_KEY values to GitHub.

## Networking

Expose internal port `3000` as a public HTTP port. Northflank will generate an HTTPS hostname and TLS certificate.

## Health check

The Docker image includes a Comlink health check using:

`/swgoh-comlink --check`

## What to send back to Thrawn's Plan

After deployment is healthy, copy:

- the public HTTPS service URL
- ACCESS_KEY
- SECRET_KEY

Those three values are what Thrawn's Plan needs for its Comlink connection. Keep the keys private.

## Expected startup

A healthy startup should report that SWGOH-Comlink is listening on port 3000 with app name `thrawns-plan`.
