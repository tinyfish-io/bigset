import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import { fromNodeHeaders } from "better-auth/node";

import { auth } from "./auth.js";
import { env } from "./env.js";
import { registerDatasetBuilderRoutes } from "./routes/dataset-builder.js";

const fastify = Fastify({ logger: true });

await fastify.register(fastifyCors, {
  origin: env.CLIENT_ORIGIN,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  credentials: true,
  maxAge: 86400,
});

fastify.route({
  method: ["GET", "POST"],
  url: "/api/auth/*",
  async handler(request, reply) {
    const url = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );
    const headers = fromNodeHeaders(request.headers);
    const body =
      request.method !== "GET" && request.body
        ? JSON.stringify(request.body)
        : undefined;

    const req = new Request(url.toString(), {
      method: request.method,
      headers,
      body,
    });

    const response = await auth.handler(req);

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });

    const text = await response.text();
    return reply.send(text || undefined);
  },
});

fastify.get("/health", async () => ({ status: "ok" }));

fastify.get("/api/me", async (request, reply) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  return reply.send(session);
});

await registerDatasetBuilderRoutes(fastify);

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
