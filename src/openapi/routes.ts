import { Router } from 'express';
import { buildOpenApiDocument } from './document.js';

export const openapiRouter = Router();

// Built once at startup — the spec only changes with a deploy.
const document = buildOpenApiDocument();

openapiRouter.get('/openapi.json', (_req, res) => {
  res.json(document);
});

const docsHtml = `<!doctype html>
<html>
  <head>
    <title>Yadah Microfinance API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/api/v1/openapi.json' });
    </script>
  </body>
</html>`;

openapiRouter.get('/docs', (_req, res) => {
  res.type('html').send(docsHtml);
});
