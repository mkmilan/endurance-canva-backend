import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const server = createApp({ config }).listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'listening', service: 'endurance-canvas-api', port: config.port, mode: config.mode }));
});
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
