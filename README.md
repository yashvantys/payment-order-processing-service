Payment & Order Processing Service
Event-driven order and payment processing service built with NestJS, TypeScript, PostgreSQL, Prisma, Redis, and BullMQ.
The project focuses on reliability patterns commonly required in payment systems:
- API idempotency
- PostgreSQL transactional consistency
- Transactional Outbox Pattern
- At-least-once event delivery
- Asynchronous payment processing
- Idempotent payment workers
- Retry and exponential backoff
- Dead-letter queue (DLQ)
- Payment-provider idempotency
- HMAC webhook verification
- Webhook event deduplication
- Payment timeout handling
- Manual reconciliation
Status: Core order, payment, outbox, webhook, retry/DLQ, reconciliation, Docker, and E2E flows are implemented. Additional production hardening and AWS integration remain on the roadmap.

Architecture
                    POST /orders
                         |
                  Idempotency-Key
                         |
                         v
              +---------------------+
              | Idempotency Check    |
              |                     |
              | same payload        |
              |   -> replay         |
              | different payload   |
              |   -> 422             |
              +----------+----------+
                         |
                         v
              +---------------------+
              | PostgreSQL TX       |
              |                     |
              | 1. idempotency key  |
              | 2. order PENDING    |
              | 3. payment PENDING  |
              | 4. outbox event     |
              +----------+----------+
                         |
                         v
                   202 Accepted
                         |
                         v
                  Outbox Relay
                         |
                         v
                BullMQ / Redis
                         |
                         v
                 Payment Worker
                         |
                         v
              Mock Payment Provider
                   /           \
                  /             \
             Success           Timeout
                |                 |
                v                 v
        SUCCESS / PAID       PROCESSING
                                  |
                                  v
                           Reconciliation
                                  |
                                  v
                             SUCCESS/PAID

Payment Provider
       |
       v
POST /webhooks/payments
       |
       v
HMAC Verification
       |
       v
Webhook Deduplication
       |
       v
PostgreSQL Transaction
       |
       +--> Payment SUCCESS / FAILED
       +--> Order PAID / PAYMENT_FAILED
       +--> Completion Outbox Event
AWS Production Mapping
The current implementation uses Redis/BullMQ locally. The architecture can be mapped to AWS:
Local	AWS-oriented deployment
NestJS API	ECS/Fargate or Lambda
PostgreSQL	Amazon RDS/Aurora PostgreSQL
Redis	Amazon ElastiCache
BullMQ	Amazon SQS
Worker	Lambda or ECS worker
Outbox events	SQS/EventBridge
Secrets	AWS Secrets Manager
Logs/Metrics	CloudWatch


AWS integration is planned; the current application is not yet an AWS production deployment.
Core Features
Implemented
- Idempotent order creation using Idempotency-Key
- Request payload hashing to reject key reuse with a different payload
- Transactional order creation for order, payment, idempotency key, and outbox event
- Transactional Outbox Pattern
- Outbox relay with retry handling
- Asynchronous payment processing through BullMQ/Redis
- Payment-provider idempotency using the internal payment ID
- Payment failure handling
- Retry and exponential backoff
- Payment DLQ handling
- HMAC webhook verification
- Webhook event deduplication
- Terminal-state protection for payment updates
- Manual payment reconciliation
- Docker Compose development environment
- Vitest + Supertest E2E tests
Planned
- Concurrent idempotency-request test/hardening
- Concurrent webhook processing hardening
- Unit/integration test suite
- GitHub Actions CI
- Swagger/OpenAPI
- Scheduled reconciliation
- Refund workflow
- AWS deployment
- Observability and distributed tracing
Design Decisions
Decision	Why
Client-supplied idempotency key	Prevents duplicate order creation during client retries
Unique (user_id, key) constraint	Protects the idempotency record from duplicates
Request payload hash	Detects reuse of the same key with a different request
PostgreSQL transaction	Keeps order/payment/idempotency/outbox writes consistent
Transactional Outbox	Prevents losing an event after a successful DB transaction
At-least-once delivery	Allows reliable retry of event publication
Idempotent payment worker	Safely handles duplicate queue delivery
Payment ID as provider idempotency key	Prevents duplicate external charges
Integer minor-unit amounts	Avoids floating-point money precision problems
Timeout keeps payment PROCESSING	A timeout does not prove whether the provider processed the payment
Webhook event ID uniqueness	Prevents duplicate webhook processing
HMAC verification	Verifies webhook authenticity
202 Accepted	Order creation returns before asynchronous payment processing completes


Data Model
The service currently uses five core tables:
Table	Purpose
orders	Order information, amount, currency, and lifecycle state
payments	Payment information and provider status
idempotency_keys	Client key, request hash, and stored response
outbox_events	Events waiting to be published
webhook_events	Provider events used for deduplication


Important Constraints
- orders.order_number is unique.
- payments.order_id is unique.
- (user_id, idempotency_key) is unique.
- (provider, provider_payment_id) is unique when the provider payment ID exists.
- (provider, provider_event_id) is unique for webhook events.
Order State
             +---------+
             | PENDING |
             +----+----+
                  |
                  v
       +---------------------+
       | PAYMENT_PROCESSING  |
       +----------+----------+
                  |
            +-----+-----+
            |           |
            v           v
        +-------+   +----------------+
        | PAID  |   | PAYMENT_FAILED |
        +-------+   +----------------+

PENDING
   |
   v
CANCELLED
Payment State
        +---------+
        | PENDING |
        +----+----+
             |
             v
        +----------+
        |PROCESSING|
        +----+-----+
             |
        +----+----+
        |         |
        v         v
    +--------+ +--------+
    |SUCCESS | | FAILED |
    +----+---+ +--------+
         |
         v
    +----------+
    | REFUNDED |
    +----------+
REFUNDED exists in the payment model for the future refund workflow. The refund API/workflow is not yet implemented.
Terminal payment states are protected from invalid backward transitions.
API
Implemented Endpoints
Method	Endpoint	Description
POST	/orders	Create an order; requires Idempotency-Key
POST	/outbox/publish	Publish pending outbox events
POST	/webhooks/payments	Process payment-provider webhook
POST	/payments/reconcile	Reconcile payments still in PROCESSING


The exact health endpoint depends on the current application module configuration. Payment lookup/refund APIs and Swagger are planned rather than documented as implemented APIs.

Create Order
Request
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-001" \
  -d '{
    "amount": 49900,
    "currency": "INR",
    "customerId": "550e8400-e29b-41d4-a716-446655440000"
  }'
49900 represents ₹499.00 when INR amounts are stored in paise.
Response
HTTP/1.1 202 Accepted
{
  "orderId": "order-123",
  "paymentId": "payment-456",
  "status": "PENDING"
}
Idempotency
The API supports safe retries through the Idempotency-Key header.
Same key + same payload
The second request replays the stored response instead of creating another order/payment.
Request 1
   |
   v
Create Order
   |
   v
Store Response

Request 2
   |
   v
Same Idempotency-Key
   |
   v
Return Stored Response
Same key + different payload
Request 1:
key    = order-001
amount = 49900

Request 2:
key    = order-001
amount = 99900

        |
        v

422 Unprocessable Entity
The service stores a SHA-256 request hash to detect this condition.
Concurrent same-key behavior is protected by the database uniqueness constraint, but dedicated concurrent-request E2E coverage remains on the roadmap.

Transactional Outbox
Order creation performs these writes inside one PostgreSQL transaction:
BEGIN

INSERT idempotency_keys
INSERT orders
INSERT payments
INSERT outbox_events

COMMIT
The application does not require successful queue publication before committing the database transaction.
The outbox relay later publishes pending events.
Database transaction succeeds
           |
           v
Message publishing fails
           |
           v
Event remains in outbox
           |
           v
Relay retries
This provides reliable event publication without coupling the business transaction directly to the message broker.
Payment Worker
The worker consumes PaymentRequested events.
PaymentRequested
       |
       v
Load Payment
       |
       +---- terminal SUCCESS/FAILED
       |             |
       |             v
       |            ACK
       |
       v
Mark Payment PROCESSING
       |
       v
Call Payment Provider
       |
       +---- Success ----> SUCCESS / PAID
       |
       +---- Failure ----> Retry
       |
       +---- Timeout ----> PROCESSING
The payment provider mock uses the internal payment ID to create a stable provider payment ID.
Mock Failure Scenarios
- amount = 999999 → simulated provider failure
- amount = 888888 → simulated provider timeout
- Other positive amounts → successful mock payment
A timeout intentionally leaves the payment in PROCESSING because the external result is unknown. Reconciliation can later query the provider and resolve it.
Retry & Dead Letter Queue
Payment jobs are configured with retry/backoff behavior.
Attempt 1
   |
   v
Failure
   |
   v
Retry with backoff
   |
   v
Attempt N
   |
   v
DLQ
After the configured attempts are exhausted, the worker records the payment failure and places the failed job in the payment DLQ with diagnostic information.
The current E2E suite verifies the payment-failure path through retry and DLQ handling.
Webhook Processing
Payment-provider webhooks follow this flow:
POST /webhooks/payments
          |
          v
Read Raw Payload
          |
          v
Verify HMAC Signature
          |
          v
Check Provider Event ID
          |
     +----+----+
     |         |
 Duplicate    New
     |         |
     v         v
   200 OK   PostgreSQL TX
                |
                v
       Insert Webhook Event
                |
                v
       Update Payment/Order
                |
                v
          Outbox Event
Webhook events are deduplicated using:
UNIQUE(provider, provider_event_id)
The webhook processing transaction records the event and updates the related payment/order state together.
Reconciliation
The service exposes a manual reconciliation endpoint for payments that remain PROCESSING.
Payment
   |
   +-- PROCESSING
          |
          v
POST /payments/reconcile
          |
          v
Query Payment Provider
          |
       +--+--+
       |     |
       v     v
   SUCCESS  UNKNOWN/other
       |
       v
Update Payment + Order
       |
       v
Create Completion Outbox Event
The timeout scenario is especially important because a provider timeout does not prove that the external payment failed.
Scheduled reconciliation is planned. The current implementation provides a manual reconciliation endpoint/service.

Security
Currently implemented security/reliability controls include:
- Request validation using NestJS ValidationPipe
- Idempotency-Key protection
- PostgreSQL uniqueness constraints
- HMAC webhook signature verification
- Webhook event deduplication
- Centralized exception handling
- Environment-based configuration
JWT authentication, refresh tokens, and RBAC are planned, not currently implemented.
Never commit real secrets to the repository.
Tech Stack
Backend
- Node.js 24
- NestJS
- TypeScript
Database
- PostgreSQL 17
- Prisma 7
- @prisma/adapter-pg
- pg
Queue
- Redis 7
- BullMQ
- @nestjs/bullmq
- ioredis
Testing
- Vitest
- Supertest
DevOps
- Docker
- Docker Compose
Planned
- GitHub Actions
- Swagger/OpenAPI
- AWS SQS/Lambda
- RDS/Aurora
- ElastiCache
- EventBridge
- CloudWatch
- Secrets Manager
Getting Started
Prerequisites
- Node.js 24+
- npm
- Docker
- Docker Compose
Clone
git clone https://github.com/<your-username>/payment-order-processing-service.git
cd payment-order-processing-service
Install dependencies
npm install
Environment
For local execution, configure:
PORT=3000

DATABASE_URL=postgresql://postgres:admin@localhost:5432/payment_order_db

REDIS_HOST=localhost
REDIS_PORT=6379

WEBHOOK_SECRET=super-secret-webhook-key
The Docker Compose API container uses the Docker service names for PostgreSQL and Redis automatically.
Start infrastructure
docker compose up -d postgres redis
Run migrations
For an existing migration history:
npx prisma migrate deploy
For local development where a new migration is required:
npx prisma migrate dev
Start application
npm run start:dev
Application:
http://localhost:3000
Docker
Build and start the complete stack:
docker compose up -d --build
Check services:
docker compose ps
View API logs:
docker compose logs -f api
Stop services:
docker compose down
docker compose down -v removes the PostgreSQL and Redis volumes and therefore deletes local persisted data.

Environment Variables
Variable	Description
PORT	Application port
DATABASE_URL	PostgreSQL connection string
REDIS_HOST	Redis hostname
REDIS_PORT	Redis port
WEBHOOK_SECRET	HMAC webhook signing secret


Testing
E2E Tests
npm run test:e2e
Current E2E coverage includes:
- Application bootstrap
- Order creation
- Idempotency replay
- Same key with different payload
- Successful payment flow
- Payment failure/retry/DLQ flow
The latest E2E run has 4 test files and 7 tests passing.
Unit Test Command
npm run test
The project is configured with Vitest. A broader unit/integration suite is still planned.
Coverage
npm run test:cov
Lint
npm run lint
Key Verified Scenarios
Scenario	Status
Create order	✅
Missing Idempotency-Key rejected	✅
Same key + same payload replay	✅
Same key + different payload → 422	✅
Transactional outbox creation	✅
Successful asynchronous payment	✅
Payment failure	✅
Payment retry	✅
Payment DLQ	✅
Invalid webhook signature → 401	✅
Valid payment webhook	✅
Duplicate webhook handling	✅
Late terminal webhook protection	✅
Payment timeout → PROCESSING	✅
Manual reconciliation	✅
Concurrent same-key E2E test	⏳
Concurrent webhook race E2E test	⏳
Unit/integration test suite	⏳
Scheduled reconciliation	⏳


Project Structure
payment-order-processing-service/
│
├── src/
│   ├── orders/
│   │   ├── dto/
│   │   ├── orders.controller.ts
│   │   └── orders.service.ts
│   │
│   ├── payments/
│   │   ├── payment-provider.service.ts
│   │   ├── payments.processor.ts
│   │   └── payments.service.ts
│   │
│   ├── outbox/
│   │   ├── outbox.controller.ts
│   │   └── outbox.relay.ts
│   │
│   ├── webhooks/
│   │   ├── webhook.controller.ts
│   │   └── webhook.service.ts
│   │
│   ├── reconciliation/
│   │   └── reconciliation.service.ts
│   │
│   ├── queue/
│   │   └── queue.module.ts
│   │
│   ├── prisma/
│   │   └── prisma.service.ts
│   │
│   ├── app.module.ts
│   └── main.ts
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── test/
│   ├── app.e2e-spec.ts
│   └── e2e/
│
├── docker-compose.yml
├── Dockerfile
├── prisma.config.ts
├── package.json
├── vitest.config.e2e.ts
└── README.md
Roadmap
Core
- [x] Database schema and migrations
- [x] orders
- [x] payments
- [x] idempotency_keys
- [x] outbox_events
- [x] webhook_events
Order & Idempotency
- [x] POST /orders
- [x] Idempotency-Key validation
- [x] Request payload hashing
- [x] Idempotency response replay
- [x] PostgreSQL transaction
- [ ] Dedicated concurrent same-key E2E test
Outbox
- [x] Outbox event creation
- [x] Outbox relay
- [x] At-least-once event publishing
- [x] Failed event retry
Payment Processing
- [x] Payment provider interface
- [x] Mock payment provider
- [x] Payment worker
- [x] Payment state/terminal-state protection
- [x] Gateway timeout handling
- [x] Exponential backoff
- [x] DLQ handling
Webhooks
- [x] Webhook endpoint
- [x] HMAC signature verification
- [x] Event ID deduplication
- [x] Payment status update
- [x] Completion outbox events
- [ ] Concurrent webhook race E2E test
Reliability
- [x] Manual reconciliation endpoint/service
- [x] Idempotent payment consumer behavior
- [ ] Scheduled reconciliation
- [ ] Broader duplicate-message tests
- [ ] Concurrent processing protection
- [ ] Broader failure-recovery test suite
Testing & DevOps
- [x] Vitest E2E tests
- [x] Supertest
- [x] Docker Compose
- [ ] Unit tests
- [ ] Integration tests
- [ ] GitHub Actions CI
- [ ] Swagger/OpenAPI
AWS
- [ ] AWS SQS integration
- [ ] Lambda payment worker
- [ ] RDS/Aurora PostgreSQL
- [ ] ElastiCache Redis
- [ ] EventBridge
- [ ] CloudWatch monitoring
- [ ] Secrets Manager
- [ ] Production deployment
Future Enhancements
- [ ] Refund workflow
- [ ] Payment reconciliation dashboard
- [ ] Circuit breaker
- [ ] Distributed tracing
- [ ] OpenTelemetry
- [ ] Datadog integration
- [ ] Kafka event streaming
- [ ] JWT authentication
- [ ] RBAC
What This Project Demonstrates
This project is designed to demonstrate senior-level backend and distributed-systems engineering rather than basic CRUD development.
Key concepts:
- NestJS modular architecture
- TypeScript
- PostgreSQL transactions
- Prisma
- API idempotency
- Transactional Outbox Pattern
- At-least-once delivery
- Idempotent consumers
- Asynchronous processing
- Retry and DLQ strategies
- Payment-provider idempotency
- Webhook security
- Webhook deduplication
- Payment state/terminal-state protection
- Reconciliation
- Distributed-system failure handling
- Docker
- Automated E2E testing
- AWS-oriented architecture
Author
Yashvant Yadav
Senior Backend Engineer / Tech Lead
Node.js | TypeScript | AWS | GraphQL | Microservices | Serverless