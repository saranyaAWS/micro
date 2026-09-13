# E-Commerce Microservices with Real-Time Order Escalation

Services:
- **cart-service** (3001) — add/remove items, checkout → creates order
- **order-service** (3002) — creates order, calls payment, then hands off to escalation for fulfillment
- **payment-service** (3003) — simulates payment processing
- **escalation-service** (3004) — assigns order to an agent; if not acknowledged within **2 minutes**,
  automatically reassigns to the next available agent, broadcasting every step in real time via
  Socket.io. Open `http://<host>/` (or `http://<host>:3004`) to watch it live on the dashboard.
- **gateway** (80) — nginx reverse proxy exposing everything under one port

## 1. Run locally to test

```bash
cd ecommerce-microservices
docker compose up --build
```

Open the live dashboard: `http://localhost/` (via gateway) or `http://localhost:3004/` directly.

### Test the full flow

```bash
# 1. Add an item to cart (example: a towel)
curl -X POST http://localhost/cart/user1/items \
  -H "Content-Type: application/json" \
  -d '{"productId":"tw01","name":"Bath Towel","qty":1,"price":499}'

# 2. Checkout -> creates order -> charges payment -> allocates an agent
curl -X POST http://localhost/cart/user1/checkout

# Watch the dashboard: order gets ASSIGNED to Agent A.
# Do nothing for 2 minutes -> it auto-ESCALATES to Agent B, then Agent C if that also times out.

# 3. To simulate an agent acknowledging in time (use the orderId from step 2's response):
curl -X POST http://localhost/escalation/acknowledge \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<ORDER_ID>","agentId":"agent-1"}'

# 4. Mark it complete once fulfilled:
curl -X POST http://localhost/escalation/complete \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<ORDER_ID>"}'
```

To shorten the demo timeout instead of waiting 2 real minutes, set
`ESCALATION_TIMEOUT_MS=15000` (15 sec) in `docker-compose.yml` under `escalation-service`
before `docker compose up --build`.

## 2. Deploy on an AWS EC2 instance

### Step 1 — Launch the instance
1. EC2 Console → Launch Instance.
2. AMI: **Ubuntu 22.04 LTS**. Type: `t2.medium` or larger (4 containers + nginx).
3. Create/select a key pair (for SSH).
4. **Security Group** — inbound rules:
   - `22` (SSH) from your IP
   - `80` (HTTP) from `0.0.0.0/0`
   - Optionally `3001-3004` from your IP only, for direct debugging.

### Step 2 — Connect and install Docker
```bash
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>

sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable docker --now
sudo usermod -aG docker $USER
# log out and back in for the group change to take effect
exit
ssh -i your-key.pem ubuntu@<EC2_PUBLIC_IP>
```

### Step 3 — Get the code onto the instance
Either `git clone` your repo, or upload this folder directly:
```bash
scp -i your-key.pem -r ecommerce-microservices ubuntu@<EC2_PUBLIC_IP>:~/
```

### Step 4 — Build and run
```bash
cd ecommerce-microservices
docker compose up -d --build
docker compose ps        # confirm all 5 containers are Up
```

### Step 5 — Access it
- Dashboard: `http://<EC2_PUBLIC_IP>/`
- API base: `http://<EC2_PUBLIC_IP>/cart/...`, `/order/...`, `/payment/...`, `/escalation/...`

### Step 6 — Keep it running / manage it
```bash
docker compose logs -f escalation-service   # watch escalation events live
docker compose restart order-service        # restart a single service
docker compose down                         # stop everything
```

### Optional hardening for production
- Swap in-memory stores for **Redis** (agent status, timers) or **DynamoDB/RDS** (orders, payments)
  so state survives container restarts and works across multiple instances.
- Put the instance behind an **Application Load Balancer** + **Auto Scaling Group** instead of a
  single EC2 box.
- Add HTTPS via **Certbot** (Let's Encrypt) on the nginx gateway, or terminate TLS at an ALB.
- Replace the simulated payment gateway with a real provider (Stripe/Razorpay) and add
  idempotency keys.
- Add a message queue (SQS/RabbitMQ) between order-service and escalation-service instead of a
  direct HTTP call, so allocation retries survive service restarts.
