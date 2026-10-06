import { createApp } from "./app";
const app = await createApp({ logging: true });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({
  port: Number(process.env.API_PORT ?? 3000),
  host: process.env.API_HOST ?? "127.0.0.1",
});
