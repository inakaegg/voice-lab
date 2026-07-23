import { Hono } from "hono";

import {
  handleRequest,
  runPublicDataRetention,
  runtimeResponse,
} from "../worker.mjs";

type WorkerBindings = Record<string, unknown>;

const app = new Hono<{ Bindings: WorkerBindings }>();

app.get("/api/runtime", (context) => runtimeResponse(context.env));

app.notFound((context) =>
  handleRequest(context.req.raw, context.env, context.executionCtx)
);

const worker = {
  fetch(
    request: Request,
    env: WorkerBindings,
    executionContext: ExecutionContext,
  ): Response | Promise<Response> {
    if (request.method === "HEAD") {
      return handleRequest(request, env, executionContext);
    }
    return app.fetch(request, env, executionContext);
  },
  async scheduled(
    controller: ScheduledController,
    env: WorkerBindings,
    _executionContext: ExecutionContext,
  ): Promise<void> {
    await runPublicDataRetention(env, new Date(controller.scheduledTime));
  },
};

export { app };
export default worker;
