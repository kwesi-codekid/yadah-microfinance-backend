import { env } from './config/env.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`yadah-microfinance-api listening on :${String(env.PORT)} (${env.NODE_ENV})`);
});
