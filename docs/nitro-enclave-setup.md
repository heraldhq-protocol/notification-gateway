# Herald Notification Gateway — Nitro Enclave Setup Guide

> **Phase 2: Real Nitro Enclave**  
> This guide covers provisioning the enclave-enabled EC2 instance, building
> the Enclave Image File (EIF), installing the vsock-to-Unix-socket proxy,
> and switching the ECS service from Fargate to the EC2 cluster.

---

## Architecture

```
ECS EC2 Task (bridge network)
  └─ gateway container
       └─ /run/herald-enclave/enclave.sock  ← host volume mount

EC2 Host
  ├─ nitro-cli run-enclave → herald-enclave.eif  (CID: 16, port: 5000)
  └─ vsock-proxy systemd service
       socat UNIX-LISTEN:/run/herald-enclave/enclave.sock,fork \
             VSOCK-CONNECT:16:5000
```

The gateway code calls `/run/herald-enclave/enclave.sock` (Unix socket).  
The proxy bridges that to the Nitro Enclave vsock endpoint.  
**The ECS container never communicates with vsock directly.**

---

## Step 1 — Launch an Enclave-Enabled EC2 Instance

> [!CAUTION]
> The `--enclave-enabled` flag **cannot be added to a running instance**.
> It must be set at launch time. You cannot modify an existing instance.

### Instance Requirements

| Setting | Value |
|---|---|
| Instance type | `c5.xlarge` minimum (4 vCPU / 8 GB RAM) |
| AMI | Amazon Linux 2023 (latest) |
| Enclave flag | `--enclave-enabled` ✅ |
| Storage | 30 GB gp3 |
| Security group | Same as current gateway EC2 (allow port 3000 from nginx SG) |
| IAM role | `herald-ecs-ec2-instance-role` (see Step 3) |

### AWS CLI Launch Command

```bash
aws ec2 run-instances \
  --image-id ami-XXXXXXXX \
  --instance-type c5.xlarge \
  --key-name your-key-pair \
  --security-group-ids sg-XXXXXXXX \
  --subnet-id subnet-XXXXXXXX \
  --iam-instance-profile Name=herald-ecs-ec2-instance-profile \
  --enclave-options 'Enabled=true' \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=herald-gateway-nitro}]' \
  --region eu-north-1
```

---

## Step 2 — Bootstrap the EC2 Instance

SSH into the new instance and run the following:

```bash
# 1. Install AWS Nitro Enclaves CLI
sudo dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel

# 2. Allocate enclave resources (half of instance memory)
#    Edit /etc/nitro_enclaves/allocator.yaml
sudo sed -i 's/memory_mib: .*/memory_mib: 512/' /etc/nitro_enclaves/allocator.yaml
sudo sed -i 's/cpu_count: .*/cpu_count: 2/' /etc/nitro_enclaves/allocator.yaml
sudo systemctl enable --now nitro-enclaves-allocator.service

# 3. Install Docker
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

# 4. Install ECS agent
sudo dnf install -y ecs-init
sudo systemctl enable --now ecs

# 5. Configure ECS agent to join the EC2 cluster
echo 'ECS_CLUSTER=herald-gateway-ec2-cluster' | sudo tee /etc/ecs/ecs.config

# 6. Restart ECS agent
sudo systemctl restart ecs

# 7. Install socat for vsock proxy
sudo dnf install -y socat

# 8. Create socket directory (matches task definition volume mount)
sudo mkdir -p /run/herald-enclave
sudo chmod 777 /run/herald-enclave
```

---

## Step 3 — IAM Instance Role

Create `herald-ecs-ec2-instance-role` with these policies attached:

```bash
# Create the role
aws iam create-role \
  --role-name herald-ecs-ec2-instance-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach ECS agent policy (allows instance to register with ECS cluster)
aws iam attach-role-policy \
  --role-name herald-ecs-ec2-instance-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name herald-ecs-ec2-instance-profile

aws iam add-role-to-instance-profile \
  --instance-profile-name herald-ecs-ec2-instance-profile \
  --role-name herald-ecs-ec2-instance-role
```

---

## Step 4 — Build the Enclave Image File (EIF)

The enclave application decrypts emails using KMS + NaCl.  
Build the EIF from your enclave source (Rust/Go/Python):

```bash
# On the EC2 instance (or in CI, then copy the EIF)
docker build -t herald-enclave:latest ./enclave/

nitro-cli build-enclave \
  --docker-uri herald-enclave:latest \
  --output-file /opt/herald/herald-enclave.eif

# Verify the build (note the PCR0/PCR1/PCR2 hashes — use these in KMS key policy)
nitro-cli describe-eif --eif-path /opt/herald/herald-enclave.eif
```

> [!IMPORTANT]
> The **PCR0 hash** from `describe-eif` must be added to your KMS key policy
> as a condition. Only enclaves with matching PCR values can use the key.
>
> ```json
> "Condition": {
>   "StringEqualsIgnoreCase": {
>     "kms:RecipientAttestation:PCR0": "<PCR0_HASH_FROM_DESCRIBE_EIF>"
>   }
> }
> ```

---

## Step 5 — Run the Enclave + vsock Proxy (systemd)

### Enclave service: `/etc/systemd/system/herald-enclave.service`

```ini
[Unit]
Description=Herald Nitro Enclave
After=nitro-enclaves-allocator.service
Requires=nitro-enclaves-allocator.service

[Service]
Type=simple
ExecStart=/usr/bin/nitro-cli run-enclave \
  --eif-path /opt/herald/herald-enclave.eif \
  --memory 512 \
  --cpu-count 2 \
  --enclave-cid 16 \
  --debug-mode
ExecStop=/usr/bin/nitro-cli terminate-enclave --all
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### vsock-to-Unix-socket proxy: `/etc/systemd/system/herald-enclave-proxy.service`

```ini
[Unit]
Description=Herald Enclave vsock → Unix socket proxy
After=herald-enclave.service
Requires=herald-enclave.service

[Service]
Type=simple
# CID 16 matches --enclave-cid above. Port 5000 must match your EIF listener.
ExecStartPre=/bin/mkdir -p /run/herald-enclave
ExecStartPre=/bin/chmod 777 /run/herald-enclave
ExecStart=/usr/bin/socat \
  UNIX-LISTEN:/run/herald-enclave/enclave.sock,fork,mode=666 \
  VSOCK-CONNECT:16:5000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### Enable both services

```bash
sudo cp herald-enclave.service /etc/systemd/system/
sudo cp herald-enclave-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now herald-enclave.service
sudo systemctl enable --now herald-enclave-proxy.service

# Verify the socket exists
test -S /run/herald-enclave/enclave.sock && echo "✅ Socket ready" || echo "❌ Socket missing"
```

---

## Step 6 — Create the ECS EC2 Cluster

```bash
aws ecs create-cluster \
  --cluster-name herald-gateway-ec2-cluster \
  --region eu-north-1
```

The EC2 instance will self-register once the ECS agent starts (Step 2, item 6).  
Verify with:

```bash
aws ecs list-container-instances \
  --cluster herald-gateway-ec2-cluster \
  --region eu-north-1
```

---

## Step 7 — Create ECS Service on the EC2 Cluster

```bash
# Register the task definition first (or let the GitHub Actions pipeline do it)
aws ecs register-task-definition \
  --cli-input-json file://docker/task-definition.gateway-nitro.json \
  --region eu-north-1

# Create the ECS service
aws ecs create-service \
  --cluster herald-gateway-ec2-cluster \
  --service-name herald-gateway-nitro-svc \
  --task-definition herald-gateway-nitro \
  --desired-count 1 \
  --launch-type EC2 \
  --region eu-north-1
```

---

## Step 8 — Create CloudWatch Log Group

```bash
aws logs create-log-group \
  --log-group-name /ecs/herald-gateway-nitro \
  --region eu-north-1
```

---

## Step 9 — Add GitHub Secrets for the Nitro Pipeline

Add these to the `herald-notification-gateway` GitHub repo:

| Secret | Value |
|---|---|
| `ECS_NITRO_CLUSTER` | `herald-gateway-ec2-cluster` |
| `ECS_NITRO_GATEWAY_SERVICE` | `herald-gateway-nitro-svc` |

---

## Step 10 — Deploy and Cut Over

1. **Trigger the Nitro pipeline:**
   ```bash
   git tag v1.0.0-nitro && git push origin v1.0.0-nitro
   ```

2. **Verify the socket inside the running container:**
   ```bash
   # SSH to the EC2 host, exec into the running container
   CONTAINER_ID=$(docker ps --filter name=herald-gateway --format '{{.ID}}')
   docker exec "$CONTAINER_ID" test -S /run/herald-enclave/enclave.sock && echo "✅"
   ```

3. **Verify gateway logs** — look for successful enclave decrypt calls (not mock responses)

4. **Update nginx upstream** to point to the EC2 instance's private IP (port 3000)

5. **Stop the Fargate service** once EC2 is confirmed stable:
   ```bash
   aws ecs update-service \
     --cluster herald-cluster \
     --service herald-gateway-svc \
     --desired-count 0 \
     --region eu-north-1
   ```

6. **Remove mock-enclave ECR images** once Fargate is decommissioned:
   ```bash
   aws ecr batch-delete-image \
     --repository-name herald/gateway-enclave \
     --image-ids imageTag=latest \
     --region eu-north-1
   ```

---

## Enclave Protocol Reference

The gateway's `EnclaveService` sends JSON over the Unix socket:

```json
{ "op": "decrypt", "owner_pubkey": "4xR9...", "encrypted_email": "...", "nonce": "..." }
```

The real EIF must:
1. Accept this JSON on vsock port `5000`
2. Call AWS KMS to unwrap the decryption key (using `HERALD_X25519_PRIV_CIPHERTEXT`)
3. NaCl box_open the `encrypted_email` using the unwrapped key
4. Return: `{ "email": "user@example.com" }`
5. **Never log the plaintext email**
