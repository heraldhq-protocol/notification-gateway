# AWS ECS & ALB Configuration for Herald

The Herald Notification Gateway is designed to run in a highly available, scalable containerized environment using **Amazon Elastic Container Service (ECS)** with AWS Fargate, fronted by an **Application Load Balancer (ALB)**.

## 1. Network Architecture (VPC Setup)

1. **VPC**: Deploy Herald in a custom VPC with at least 2 Availability Zones (AZs).
2. **Subnets**:
   - **Public Subnets**: For the Application Load Balancer and NAT Gateways.
   - **Private Subnets**: For the ECS Fargate Tasks, RDS (PostgreSQL), and ElastiCache (Redis).
3. **NAT Gateway**: Required for ECS tasks in private subnets to communicate with external APIs (Solana RPCs, Telegram API, SMTP servers, etc).

## 2. Security Groups

Create three primary Security Groups (SGs):

1. **ALB Security Group**:
   - **Inbound**: Allow port `443` (HTTPS) from `0.0.0.0/0`. Allow port `80` (HTTP) from `0.0.0.0/0` (redirect to 443).
   - **Outbound**: Allow all to the ECS Task Security Group.

2. **ECS Task Security Group**:
   - **Inbound**: Allow port `3000` (or `PORT` env var) ONLY from the **ALB Security Group**.
   - **Outbound**: Allow `0.0.0.0/0` (for outbound API calls and DB/Redis access).

3. **Data Security Group (RDS & Redis)**:
   - **Inbound**: Allow PostgreSQL (`5432`) and Redis (`6379`) ONLY from the **ECS Task Security Group**.

## 3. ElastiCache (Redis) & RDS (PostgreSQL)

- **Redis**: Use ElastiCache for Redis in Cluster Mode Disabled (for simplicity) or Enabled (if high throughput requires sharding). Enable **In-Transit Encryption (TLS)**.
- **RDS**: Use Amazon Aurora PostgreSQL or standard RDS. Enable **Storage Encryption** and enforce SSL/TLS for connections.

*Note: In the Herald environment config, ensure `DATABASE_URL` contains `?sslmode=require` and `REDIS_URL` uses `rediss://`.*

## 4. Application Load Balancer (ALB) Setup

1. **Create an Internet-Facing ALB** in your Public Subnets.
2. **Listeners**:
   - HTTP (80): Redirect to HTTPS (443).
   - HTTPS (443): Attach an ACM (AWS Certificate Manager) certificate for `api.useherald.xyz` or `notify.useherald.xyz`.
3. **Target Group**:
   - **Target Type**: `IP` (required for Fargate).
   - **Protocol**: `HTTP`, **Port**: `3000`.
   - **Health Check Path**: `/health` or `/` (Ensure this route returns `200 OK`).
   - **Healthy Threshold**: 3.
   - **Unhealthy Threshold**: 2.
   - **Timeout**: 5 seconds.
   - **Interval**: 30 seconds.

## 5. ECS Fargate Cluster & Task Definition

1. **Cluster**: Create a new ECS Cluster powered by AWS Fargate.
2. **Task Definition**:
   - **Launch Type**: Fargate.
   - **Network Mode**: `awsvpc`.
   - **CPU**: 1024 (1 vCPU) minimum recommended.
   - **Memory**: 2048 (2 GB) minimum recommended.
   - **Task Role**: Must have permissions for `kms:Decrypt` (see `kms-setup.md`).
   - **Task Execution Role**: Needs `AmazonECSTaskExecutionRolePolicy` to pull ECR images and push CloudWatch logs.
3. **Container Definition**:
   - **Image**: Your ECR image URI.
   - **Port Mappings**: Container port `3000`.
   - **Environment Variables**: Configure all required environment variables. Inject sensitive values using AWS Secrets Manager or Parameter Store (e.g., `valueFrom`).

### Recommended Environment Variables for ECS

```env
NODE_ENV=production
PORT=3000

# Infrastructure Endpoints
DATABASE_URL=postgres://user:password@herald-db.cluster-xxxx.us-east-1.rds.amazonaws.com:5432/herald?sslmode=require
REDIS_URL=rediss://herald-redis.xxxx.use1.cache.amazonaws.com:6379

# Internal Services
INTERNAL_SERVICE_SECRET=arn:aws:secretsmanager:... (Reference)

# See kms-setup.md for AWS_KMS_KEY_ID and ciphertexts
```

## 6. ECS Service Deployment

1. **Create Service** inside the ECS Cluster.
2. Select **Fargate**.
3. Choose the Task Definition created above.
4. **Desired Tasks**: 2 (for High Availability across 2 AZs).
5. **Network Configuration**: Select your **Private Subnets** and the **ECS Task Security Group**.
6. **Load Balancing**: Select **Application Load Balancer**, choose your target group.
7. **Auto Scaling**: Configure Target Tracking Scaling Policies based on CPU Utilization (target ~60-70%) or Memory Utilization.

## 7. Operational Best Practices

- **Graceful Shutdowns**: The NestJS app listens for `SIGTERM`. In ECS, set `stopTimeout` to 30 seconds to allow BullMQ workers to finish active jobs before the container is forcefully killed.
- **BullMQ Workers**: The Herald Gateway runs API processes and background workers in the same container. For higher scale, duplicate the Task Definition, disable the API on the worker containers (via an env var), and disable workers on the API containers.
