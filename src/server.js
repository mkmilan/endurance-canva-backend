import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { initializeCreator } from './creator.js';

const config = loadConfig();
const creator = await initializeCreator(config);
const server = createApp({ config, creator }).listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'listening', service: 'endurance-canvas-api', port: config.port, creatorConfigured: Boolean(creator) }));
});
function shutdown() {
  server.close(async () => { await creator?.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
