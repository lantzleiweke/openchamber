import express from 'express';
import { asControlError } from './error.js';

export const registerOpenChamberControlRoutes = (app, { controlService }) => {
  app.post('/api/openchamber/control', express.json({ limit: '1mb' }), async (req, res) => {
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    try {
      const action = typeof req.body?.action === 'string' ? req.body.action : '';
      const requestInput = req.body?.input;
      const input = requestInput && typeof requestInput === 'object' && !Array.isArray(requestInput)
        ? requestInput
        : {};
      const data = await controlService.execute(action, input, req.body?.contextDirectory, { signal: controller.signal });
      return res.json(data);
    } catch (error) {
      const controlError = asControlError(error, 'OpenChamber control action failed');
      return res.status(controlError.statusCode).json({
        error: controlError.message,
        ...(controlError.partial === true ? {
          partial: true,
          partialAction: controlError.partialAction,
          sessionId: controlError.sessionId,
          directory: controlError.directory,
        } : {}),
      });
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
    }
  });

  // The user answered a page an agent is waiting on (render.page with
  // awaitAnswer). The agent's call holds the matching request open.
  app.post('/api/openchamber/render/answer', express.json({ limit: '64kb' }), (req, res) => {
    try {
      return res.json(controlService.answerPage(req.body ?? {}));
    } catch (error) {
      const controlError = asControlError(error, 'Could not deliver the answer');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  // The page a call holds while it waits, for a client that reloaded or
  // connected after the call began: OpenCode's stored copy of a running call
  // carries no metadata, and a page named by file is not in its input.
  app.get('/api/openchamber/render/page', (req, res) => {
    try {
      const { sessionId, callId } = req.query;
      return res.json(controlService.waitingPage({
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        callId: typeof callId === 'string' ? callId : '',
      }));
    } catch (error) {
      const controlError = asControlError(error, 'Could not read the waiting page');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });
};
