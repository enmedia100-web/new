/**
 * Higgsfield API example — Seedance 2.5 text-to-video.
 *
 * Credentials are read at runtime from .env.local (HF_CREDENTIALS, in
 * "key-id:key-secret" format) and are never printed or logged.
 *
 * Run with: npm run generate
 */
import { config as loadEnv } from 'dotenv';
import axios from 'axios';
import { higgsfield, config } from '@higgsfield/client/v2';
import {
  AuthenticationError,
  CredentialsMissedError,
  NotEnoughCreditsError,
  TimeoutError,
  APIError,
} from '@higgsfield/client/v2';

loadEnv({ path: '.env.local' });

const ENDPOINT = 'bytedance/seedance-2.5/text-to-video';
const BASE_URL = 'https://api.higgsfield.ai';

/**
 * The SDK maps any HTTP 403 to NotEnoughCreditsError. An outbound proxy that
 * refuses a CONNECT tunnel also answers 403, which would be reported as a
 * billing problem even though the request never reached Higgsfield. This
 * probe tells the two apart: a transport-level failure means the host is
 * unreachable, whereas an HTTP response of any status means it is reachable.
 */
async function apiIsReachable(): Promise<boolean> {
  try {
    const response = await axios.get(BASE_URL, {
      timeout: 15_000,
      validateStatus: () => true,
    });
    // An intercepting proxy answers with its own 403 and an explanatory body
    // rather than failing the connection, so status alone cannot be trusted.
    const body = typeof response.data === 'string' ? response.data : '';
    const blockedByProxy =
      response.status === 403 &&
      /request blocked|no rule or allowlist|not allowed|forbidden by proxy/i.test(body);
    return !blockedByProxy;
  } catch {
    // Transport-level failure: DNS, TLS or a refused tunnel.
    return false;
  }
}

const credentials = process.env.HF_CREDENTIALS;

if (!credentials) {
  console.error(
    'HF_CREDENTIALS is not set. Add it to .env.local as:\n' +
      '  HF_CREDENTIALS=key-id:key-secret',
  );
  process.exit(1);
}

// Shape check only — the value itself is never printed.
if (!/^[^:\s]+:[^:\s]+$/.test(credentials)) {
  console.error(
    'HF_CREDENTIALS is set but is not in "key-id:key-secret" format.',
  );
  process.exit(1);
}

config({ credentials });

async function main(): Promise<void> {
  console.log(`Submitting generation to ${ENDPOINT} ...`);

  const result = await higgsfield.subscribe(ENDPOINT, {
    input: {
      prompt: 'A cinematic scene at sunset',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    },
    withPolling: true,
  });

  console.log(`Request ID: ${result.request_id}`);
  console.log(`Status: ${result.status}`);

  // Only `completed` counts as success. `failed` and `nsfw` are terminal
  // failures the API reports explicitly; anything else (including a request
  // cancelled via cancel_url) is treated as unsuccessful rather than assumed.
  if (result.status !== 'completed') {
    if (result.status === 'nsfw') {
      console.error('Generation was rejected by content moderation. Credits are refunded.');
    } else if (result.status === 'failed') {
      console.error('Generation failed. Credits are refunded.');
    } else {
      console.error(`Generation did not complete (status: ${result.status}).`);
    }
    process.exit(1);
  }

  const videoUrl = result.video?.url;

  if (!videoUrl) {
    console.error('Status is "completed" but the response contained no video URL.');
    console.error('Raw response:', JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log(`\nVideo URL: ${videoUrl}`);
}

main().catch(async (error: unknown) => {
  if (error instanceof CredentialsMissedError || error instanceof AuthenticationError) {
    console.error('Authentication failed. Check HF_CREDENTIALS in .env.local.');
  } else if (error instanceof NotEnoughCreditsError) {
    // Distinguish a genuine billing 403 from a proxy that blocked the request.
    if (await apiIsReachable()) {
      console.error('Not enough credits in the Higgsfield workspace for this generation.');
    } else {
      console.error(
        `Could not reach ${BASE_URL}. The request was blocked before it left this\n` +
          'machine, most likely by an outbound proxy or firewall. The SDK reports\n' +
          'such a rejection as "Not enough credits" because both answer HTTP 403,\n' +
          'so this is a connectivity problem, not necessarily a billing one.',
      );
    }
  } else if (error instanceof TimeoutError) {
    console.error(`Timed out waiting for the generation to finish: ${error.message}`);
  } else if (error instanceof APIError) {
    console.error(`API error${error.statusCode ? ` (${error.statusCode})` : ''}: ${error.message}`);
  } else {
    console.error('Unexpected error:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
