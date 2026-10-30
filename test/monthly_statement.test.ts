import assert from "node:assert/strict";
import test from "node:test";
import { ordersReadyToFile, statementRequestSchema, statementTotalMinor } from "../src/monthly_statement.js";

test("files only delivered, receipted orders checked out inside the UTC month", () => {
  const base = {
    customer: { customer_id: "cus_42", name: "Ada Shop", email: "ops@example.com" },
    period: "2026-08",
    orders: [
      {
        order_id: "august-last-second",
        checkout: { completed_at: "2026-08-31T23:59:59.999Z", amount_minor: 1250, currency: "USD" },
        fulfillment: { status: "delivered" as const, fulfilled_at: "2026-09-02T09:00:00.000Z" },
        receipt: { number: "R-100", issued_at: "2026-08-31T23:59:59.999Z" },
        updates: [{ at: "2026-09-02T09:00:00.000Z", status: "delivered" }],
      },
      {
        order_id: "cancelled",
        checkout: { completed_at: "2026-08-12T10:00:00.000Z", amount_minor: 900, currency: "USD" },
        fulfillment: { status: "cancelled" as const },
        receipt: { number: "R-101", issued_at: "2026-08-12T10:00:00.000Z" },
        updates: [{ at: "2026-08-13T10:00:00.000Z", status: "cancelled" }],
      },
      {
        order_id: "next-month",
        checkout: { completed_at: "2026-09-01T00:00:00.000Z", amount_minor: 400, currency: "USD" },
        fulfillment: { status: "delivered" as const },
        receipt: { number: "R-102", issued_at: "2026-09-01T00:00:00.000Z" },
        updates: [{ at: "2026-09-01T08:00:00.000Z", status: "delivered" }],
      },
    ],
  };
  const input = statementRequestSchema.parse(base);

  assert.deepEqual(ordersReadyToFile(input).map((order) => order.order_id), ["august-last-second"]);
  assert.equal(statementTotalMinor(input), 1250);
});
