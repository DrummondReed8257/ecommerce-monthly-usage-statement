import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { statementRequestSchema, sendMonthlyStatement, InfraiError } from "./monthly_statement.js";

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.INFRAI_API_KEY;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/statements/send") {
    json(response, 404, { error: "not_found" });
    return;
  }
  if (!apiKey) {
    json(response, 503, { error: "INFRAI_API_KEY is required" });
    return;
  }

  let input;
  try {
    input = statementRequestSchema.parse(await readJson(request));
  } catch (error) {
    const details = error instanceof ZodError ? error.flatten() : "Request body must be valid JSON";
    json(response, 400, { error: "invalid_request", details });
    return;
  }

  try {
    json(response, 200, await sendMonthlyStatement(input, apiKey));
  } catch (error) {
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      json(response, status, { error: error.code, details: error.details });
      return;
    }
    const details = error instanceof Error ? error.message : "Upstream request failed";
    json(response, 502, { error: "statement_delivery_failed", details });
  }
});

server.listen(port, () => {
  console.log(`Statement service listening on http://localhost:${port}`);
});
