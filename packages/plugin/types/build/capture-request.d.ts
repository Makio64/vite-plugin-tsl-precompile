import type { IncomingMessage } from 'node:http';

export declare const DEV_CAPTURE_MAX_BODY_BYTES: number;
export declare function readCaptureBody( request: IncomingMessage, maxBytes?: number ): Promise<string>;
