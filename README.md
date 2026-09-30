# Payment & Order Processing Service

Event-driven order and payment processing service built with **NestJS**, **TypeScript**, **PostgreSQL**, **Prisma**, **Redis**, and **BullMQ**.

The project focuses on reliability challenges commonly found in payment systems, including **API idempotency, transactional consistency, reliable event publishing, asynchronous payment processing, safe retries, dead-letter handling, webhook verification, and event deduplication**.

> **Status:** In progress. See the [Roadmap](#roadmap) for implementation progress.

---

## Features

Features are ticked off in the [Roadmap](#roadmap) as they are implemented.

* **Idempotent order creation** — clients provide an `Idempotency-Key` header so retried requests do not create duplicate orders or payments.
* **Transactional outbox** — order, payment, and outbox records are committed atomically in PostgreSQL.
* **Asynchronous payment processing** — payment requests are published through the outbox and processed asynchronously by a worker.
* **Safe retries** — payment processing uses timeouts, exponential backoff, retry limits, and a dead-letter queue (DLQ).
* **Payment-provider idempotency** — the internal payment ID is used as the provider idempotency key.
* **Verified webhooks** — HMAC signature verification protects webhook processing.
* **Webhook deduplication** — provider event IDs are persisted to prevent duplicate processing.
* **Payment state machine** — payment transitions are controlled and terminal states cannot move backwards.
* **Reconciliation** — scheduled reconciliation can resolve payments that remain unresolved (`PROCESSING`) because the external outcome is unknown.
* **Authentication** — JWT access and refresh tokens with role-based access control (RBAC).
* **Automated testing** — unit and end-to-end tests cover important failure scenarios.

---

## Architecture

```text
POST /orders
Idempotency-Key: <client-key>
        |
        v
+-------------------------+
| Idempotency Check       |
|                         |
| Existing key?           |
|  same payload -> replay |
|  different payload     |
|       -> 422            |
|  new key -> continue    |
+------------+------------+
             |
             v
+--------------------------------------+
| PostgreSQL Transaction               |
|                                      |
| 1. Insert idempotency key            |
| 2. Create Order       -> PENDING     |
| 3. Create Payment     -> PENDING     |
| 4. Create Outbox Event               |
|    PaymentRequested                  |
+-------------------+------------------+
                    |
                    v
              202 Accepted
                    |
                    v
              Outbox Relay
                    |
                    v
          PaymentRequested Event
                    |
                    v
             BullMQ / Redis
                    |
                    v
             Payment Worker
                    |
                    v
            Payment Gateway
             /           \
            /             \
           v               v
    Gateway Result       Webhook
                           |
                           v
                    HMAC Verification
                           |
                           v
                  Webhook Event Dedup
                           |
                           +-------------+
                                         |
                                         v
                         +-------------------------------+
                         | PostgreSQL Transaction        |
                         |                               |
                         | Payment -> SUCCESS / FAILED  |
                         | Order   -> PAID / PAYMENT_FAILED |
                         | Outbox  -> Completion Event  |
                         +---------------+---------------+
                                         |
                                         v
                                  Outbox Relay
                                         |
                                         v
                         PaymentCompleted / PaymentFailed
```

### AWS Production Mapping

The local implementation uses Redis and BullMQ for asynchronous processing. The architecture can be mapped to AWS services:

```text
NestJS API
    |
    +--> PostgreSQL / Amazon RDS
    |
    +--> Redis / ElastiCache
    |
    +--> SQS
           |
           v
       Lambda / Worker
           |
           v
    Payment Provider

Outbox Events
    |
    v
EventBridge / SQS
```

---

## Design Decisions

| Decision                               | Why                                                                 |
| -------------------------------------- | ------------------------------------------------------------------- |
| Client-supplied idempotency key        | Prevents duplicate order creation when clients retry requests       |
| Unique idempotency constraint          | Protects against concurrent duplicate requests                      |
| Request payload hash                   | Detects reuse of the same key with a different request              |
| Transactional outbox                   | Commits business state and event intent atomically                  |
| At-least-once delivery                 | Allows reliable retry of failed event publication                   |
| Idempotent worker                      | Safely handles duplicate queue delivery                             |
| Payment ID as provider idempotency key | Prevents duplicate charges during payment retries                   |
| Money stored as integer minor units    | Avoids floating-point precision problems                            |
| Timeout keeps payment `PROCESSING`     | A timeout does not prove whether the provider processed the payment |
| Webhook event ID deduplication         | Prevents duplicate webhook processing                               |
| HMAC verification                      | Ensures webhook authenticity                                        |
| `202 Accepted`                         | Payment processing happens asynchronously                           |

---

## Tech Stack

### Backend

* Node.js
* NestJS
* TypeScript

### Database

* PostgreSQL
* Prisma ORM

### Queue & Cache

* Redis
* BullMQ

### Authentication & Security

* JWT
* Refresh tokens
* RBAC
* HMAC webhook verification
* Request validation

### Testing

* Jest
* Supertest

### Development & DevOps

* Docker
* Docker Compose
* GitHub Actions
* Swagger / OpenAPI

### AWS

The architecture is designed to support:

* Amazon SQS
* AWS Lambda
* Amazon EventBridge
* Amazon RDS
* Amazon ElastiCache
* AWS Secrets Manager
* Amazon CloudWatch

---

## Data Model

The core service uses five tables.

| Table              | Purpose                                        |
| ------------------ | ---------------------------------------------- |
| `orders`           | Order information, amount and lifecycle state  |
| `payments`         | Payment information and provider status        |
| `idempotency_keys` | Client key, request hash and stored response   |
| `outbox_events`    | Events waiting to be published                 |
| `webhook_events`   | Payment-provider events used for deduplication |

### Relationship

```text
orders
   |
   | 1 : 1
   v
payments


idempotency_keys
       |
       | protects API requests
       v
POST /orders


outbox_events
       |
       v
Message Broker / Queue


webhook_events
       |
       v
Payment Provider Webhooks
```

---

## Order State Machine

```text
                +-------------------+
                |      PENDING      |
                +---------+---------+
                          |
                          v
                +-------------------+
                | PAYMENT_PROCESSING|
                +---------+---------+
                          |
                    +-----+-----+
                    |           |
                    v           v
              +---------+   +---------------+
              |  PAID   |   | PAYMENT_FAILED|
              +---------+   +---------------+

PENDING
   |
   v
CANCELLED
```

---

## Payment State Machine

```text
             +---------+
             | PENDING |
             +----+----+
                  |
                  v
            +-----------+
            | PROCESSING|
            +-----+-----+
                  |
            +-----+-----+
            |           |
            v           v
       +---------+   +---------+
       | SUCCESS |   | FAILED  |
       +---------+   +---------+
           |
           v
       +---------+
       | REFUNDED|
       +---------+
```

Terminal states are not allowed to transition backwards.

`REFUNDED` is planned. It arrives with the refund workflow (see the Roadmap).

---

## API

| Method | Endpoint             | Description                                 |
| ------ | -------------------- | ------------------------------------------- |
| `POST` | `/orders`            | Create an order; requires `Idempotency-Key` |
| `GET`  | `/orders/:id`        | Get order and payment status                |
| `POST` | `/webhooks/payments` | Payment-provider webhook                    |
| `GET`  | `/health`            | Health check                                |

Future payment APIs:

| Method | Endpoint               | Description    |
| ------ | ---------------------- | -------------- |
| `GET`  | `/payments/:id`        | Get payment    |
| `POST` | `/payments/:id/refund` | Refund payment |

---

## Create Order

### Request

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7" \
  -d '{
    "amount": 49900,
    "currency": "INR",
    "customerId": "cus_123"
  }'
```

`49900` represents **₹499.00** when amounts are stored in INR minor units (paise).

### Response

```http
HTTP/1.1 202 Accepted
```

```json
{
  "orderId": "order-123",
  "paymentId": "payment-456",
  "status": "PENDING"
}
```

Repeating the same request with the same `Idempotency-Key` returns the previously stored response instead of creating another order or payment.

---

## Idempotency

The API supports safe retries using the `Idempotency-Key` header.

### Same key + same payload

```text
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
```

### Same key + different payload

```text
Request 1
amount = 49900
key    = abc-123

Request 2
amount = 99900
key    = abc-123

             |
             v

        422 Unprocessable Entity
```

The service stores a request hash to detect this situation.

### Same key, concurrent requests

The idempotency key is inserted inside the order transaction, protected by a unique constraint. If two identical requests arrive together, the second waits for the first transaction to finish and then receives the stored response. If the wait times out, it returns `409 Conflict` and the client retries later.

---

## Transactional Outbox

Order creation uses a single PostgreSQL transaction:

```text
BEGIN

INSERT idempotency_keys

INSERT orders

INSERT payments

INSERT outbox_events

COMMIT
```

The application does **not** depend on publishing the message before committing the transaction.

The outbox relay later publishes the event.

This protects against:

```text
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
```

---

## Payment Worker

The worker consumes `PaymentRequested` events.

```text
PaymentRequested
       |
       v
Check Payment Status
       |
       +---- SUCCESS/FAILED
       |          |
       |          v
       |       ACK message
       |
       v
Mark Payment PROCESSING
       |
       v
Call Payment Gateway
       |
       +---- Success ----> SUCCESS
       |
       +---- Failure ----> Retry
       |
       +---- Timeout ----> stays PROCESSING / Retry
```

The worker uses the internal payment ID as the payment-provider idempotency key.

---

## Retry & Dead Letter Queue

Transient failures use exponential backoff.

```text
Attempt 1
   |
   v
Failure
   |
   v
Retry
   |
   v
Attempt 2
   |
   v
Retry
   |
   v
Attempt N
   |
   v
DLQ
```

The exact retry count and backoff values are configurable.

Non-retryable errors are not repeatedly retried.

---

## Webhook Processing

Payment providers can send asynchronous payment updates.

```text
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
 Already     New
     |         |
     v         v
  200 OK   PostgreSQL Transaction
               |
               v
      Insert Event ID (unique)
      + Process Payment
               |
        +------+------+
        |             |
        v             v
     Payment        Order
        |
        v
    Outbox Event
```

Webhook events are deduplicated using:

```text
UNIQUE(provider, provider_event_id)
```

The event ID insert and the payment, order and outbox updates happen in **one transaction**. A crash cannot leave an event recorded but never applied. A unique violation means the event is a duplicate, so the endpoint returns `200 OK`.

---

## Reconciliation

A scheduled reconciliation process handles payments that remain `PROCESSING` when the external payment result is unknown.

Example:

```text
Payment
  |
  +-- PROCESSING for too long
          |
          v
Reconciliation Job
          |
          v
Query Payment Provider
          |
      +---+---+
      |       |
      v       v
 SUCCESS   FAILED
      |       |
      v       v
 Update    Update
 Payment   Payment
```

This is particularly important for gateway timeout scenarios where the request outcome is unknown.

---

## Security

The service includes:

* JWT authentication
* Refresh tokens
* Role-based authorization
* Request validation
* HMAC webhook signature verification
* Webhook event deduplication
* Idempotency protection
* Database constraints
* Secure environment configuration
* Centralized exception handling

Secrets should not be committed to the repository.

---

## Getting Started

### Prerequisites

* Node.js 20+
* Docker
* Docker Compose
* npm

### Clone

```bash
git clone https://github.com/<your-username>/payment-order-processing-service.git

cd payment-order-processing-service
```

### Environment

```bash
cp .env.example .env
```

Example:

```env
PORT=3000

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/payment_service

REDIS_URL=redis://localhost:6379

JWT_SECRET=change-me

WEBHOOK_SECRET=change-me

PAYMENT_GATEWAY_URL=http://localhost:4000
```

### Start infrastructure

```bash
docker compose up -d
```

### Install dependencies

```bash
npm install
```

### Run database migrations

```bash
npm run migrate
```

### Start application

```bash
npm run start:dev
```

Application:

```text
http://localhost:3000
```

Swagger:

```text
http://localhost:3000/docs
```

---

## Environment Variables

| Variable              | Description                  |
| --------------------- | ---------------------------- |
| `PORT`                | Application port             |
| `DATABASE_URL`        | PostgreSQL connection string |
| `REDIS_URL`           | Redis connection string      |
| `JWT_SECRET`          | JWT signing secret           |
| `WEBHOOK_SECRET`      | HMAC webhook secret          |
| `PAYMENT_GATEWAY_URL` | Payment gateway base URL     |

---

## Testing

### Unit Tests

```bash
npm run test
```

### E2E Tests

```bash
npm run test:e2e
```

### Coverage

```bash
npm run test:cov
```

### Lint

```bash
npm run lint
```

---

## Key Test Scenarios

The test suite will cover:

* Successful order creation
* Duplicate order with the same idempotency key
* Same key with a different payload
* Concurrent requests with the same idempotency key
* Transaction rollback
* Outbox event creation
* Outbox relay retry
* Successful payment
* Payment failure
* Gateway timeout
* Payment retry
* DLQ handling
* Duplicate queue delivery
* Duplicate webhook event
* Invalid webhook signature
* Invalid webhook payload
* Payment reconciliation
* Authentication failures
* Authorization failures

---

## Project Structure

```text
payment-order-processing-service/
│
├── src/
│   ├── orders/
│   │   ├── orders.controller.ts
│   │   ├── orders.service.ts
│   │   ├── orders.repository.ts
│   │   └── dto/
│   │
│   ├── payments/
│   │   ├── payments.service.ts
│   │   ├── payment.gateway.ts
│   │   ├── payment-state-machine.ts
│   │   └── dto/
│   │
│   ├── idempotency/
│   │   ├── idempotency.service.ts
│   │   └── idempotency.repository.ts
│   │
│   ├── outbox/
│   │   ├── outbox.service.ts
│   │   └── outbox.relay.ts
│   │
│   ├── workers/
│   │   └── payment.worker.ts
│   │
│   ├── webhooks/
│   │   ├── webhook.controller.ts
│   │   ├── webhook.service.ts
│   │   └── hmac.guard.ts
│   │
│   ├── auth/
│   │   ├── auth.service.ts
│   │   ├── jwt.strategy.ts
│   │   └── guards/
│   │
│   ├── reconciliation/
│   │   └── reconciliation.service.ts
│   │
│   ├── common/
│   │   ├── filters/
│   │   ├── interceptors/
│   │   ├── guards/
│   │   └── logging/
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
│   ├── unit/
│   └── e2e/
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
└── README.md
```

---

## Roadmap

### Core

* [X] Database schema and migrations
* [X] `orders` table
* [X] `payments` table
* [X] `idempotency_keys` table
* [X] `outbox_events` table
* [X] `webhook_events` table

### Order & Idempotency

* [X] `POST /orders`
* [X] Idempotency-Key validation
* [X] Request payload hashing
* [X] Idempotency response replay
* [ ] Concurrent request protection
* [X] PostgreSQL transaction

### Outbox

* [X] Outbox event creation
* [ ] Outbox relay
* [ ] At-least-once event publishing
* [ ] Failed event retry

### Payment Processing

* [ ] Payment gateway interface
* [ ] Mock payment gateway
* [ ] Payment worker
* [ ] Payment state machine
* [ ] Gateway timeout handling
* [ ] Exponential backoff
* [ ] DLQ handling

### Webhooks

* [ ] Webhook endpoint
* [ ] HMAC signature verification
* [ ] Event ID deduplication
* [ ] Payment status update
* [ ] Completion outbox events

### Reliability

* [ ] Reconciliation job
* [ ] Duplicate message handling
* [ ] Concurrent processing protection
* [ ] Failure recovery tests

### Testing & DevOps

* [ ] Unit tests
* [ ] Integration tests
* [ ] E2E tests
* [ ] Docker Compose
* [ ] GitHub Actions CI
* [ ] Swagger/OpenAPI

### AWS

* [ ] AWS SQS integration
* [ ] Lambda payment worker
* [ ] RDS PostgreSQL
* [ ] ElastiCache Redis
* [ ] EventBridge
* [ ] CloudWatch monitoring
* [ ] Secrets Manager
* [ ] Production deployment

### Future Enhancements

* [ ] Refund workflow
* [ ] Payment reconciliation dashboard
* [ ] Circuit breaker
* [ ] Distributed tracing
* [ ] OpenTelemetry
* [ ] Datadog integration
* [ ] Kafka event streaming

---

## What This Project Will Demonstrate

This project is designed to demonstrate practical senior-level backend engineering rather than basic CRUD development.

Key concepts include:

* **NestJS modular architecture**
* **TypeScript**
* **PostgreSQL transactions**
* **Prisma**
* **API idempotency**
* **Transactional Outbox Pattern**
* **At-least-once event delivery**
* **Idempotent consumers**
* **Asynchronous processing**
* **Retry and DLQ strategies**
* **Payment-provider idempotency**
* **Webhook security**
* **Webhook deduplication**
* **State-machine design**
* **Reconciliation**
* **Distributed-system failure handling**
* **JWT/RBAC**
* **Automated testing**
* **Docker**

---

## Author

**Yashvant Yadav**

Senior Backend Engineer

+91-9601062671
yashvanty@gmail.com

**Node.js | TypeScript | AWS | GraphQL | Microservices | Serverless**

