import { SecurityConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import { JSDOM } from 'jsdom';
import type { TransformCallback } from 'stream';
import { Transform } from 'stream';

export const isIframeSandboxDisabled = () => {
	return Container.get(SecurityConfig).disableIframeSandboxing;
};

/**
 * Checks if the given string contains HTML.
 */
export const hasHtml = (str: string) => {
	try {
		const dom = new JSDOM(str);
		return (
			dom.window.document.body.children.length > 0 || dom.window.document.head.children.length > 0
		);
	} catch {
		return false;
	}
};

/**
 * Sandboxes the HTML response to prevent possible exploitation, if the data has HTML.
 * If the data does not have HTML, it will be returned as is.
 * Otherwise, it embeds the response in an iframe to make sure the HTML has a different origin.
 * Env var `N8N_INSECURE_DISABLE_WEBHOOK_IFRAME_SANDBOX` can be used, in this case sandboxing is disabled.
 *
 * @param data - The data to sandbox.
 * @param forceSandbox - Whether to force sandboxing even if the data does not contain HTML.
 * @returns The sandboxed HTML response.
 */
export const sandboxHtmlResponse = <T>(data: T, forceSandbox = false) => {
	if (isIframeSandboxDisabled()) return data;

	let text;
	if (typeof data !== 'string') {
		text = JSON.stringify(data);
	} else {
		text = data;
	}

	if (!forceSandbox && !hasHtml(text)) return text;

	// Escape & and " as mentioned in the spec:
	// https://html.spec.whatwg.org/multipage/iframe-embed-object.html#the-iframe-element
	const escapedHtml = text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

	return `<iframe srcdoc="${escapedHtml}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-orientation-lock allow-pointer-lock allow-presentation allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
			style="position:fixed; top:0; left:0; width:100vw; height:100vh; border:none; overflow:auto;"
			allowtransparency="true"></iframe>`;
};

/**
 * Converts ampersands and double quotes in a buffer to their HTML entities.
 * Does double pass on the buffer to avoid multiple allocations.
 *
 * @example
 * ```ts
 * const input = Buffer.from('Hello & "World"', 'utf8');
 * const result = bufferEscapeHtml(input);
 * console.log(result.toString()); // 'Hello &amp; &quot;World&quot;'
 * ```
 */
export const bufferEscapeHtml = (input: Buffer) => {
	const ampersand = Buffer.from('&', 'utf8').readUInt8(0);
	const escapedAmpersand = Buffer.from('&amp;', 'utf8');
	const doublequote = Buffer.from('"', 'utf8').readUInt8(0);
	const escapedDoublequote = Buffer.from('&quot;', 'utf8');

	let ampersandCount = 0;
	let doublequoteCount = 0;

	for (let i = 0; i < input.length; i++) {
		if (input[i] === ampersand) ampersandCount++;
		else if (input[i] === doublequote) doublequoteCount++;
	}

	if (ampersandCount === 0 && doublequoteCount === 0) return Buffer.from(input);

	const resultLength =
		input.length +
		ampersandCount * (escapedAmpersand.length - 1) +
		doublequoteCount * (escapedDoublequote.length - 1);
	const output = Buffer.alloc(resultLength);
	let writeOffset = 0;

	for (let i = 0; i < input.length; i++) {
		if (input[i] === ampersand) {
			escapedAmpersand.copy(output, writeOffset);
			writeOffset += escapedAmpersand.length;
		} else if (input[i] === doublequote) {
			escapedDoublequote.copy(output, writeOffset);
			writeOffset += escapedDoublequote.length;
		} else {
			output[writeOffset++] = input[i];
		}
	}

	return output;
};

/**
 * Creates a transform stream that sandboxes HTML content by wrapping it in an iframe.
 * This is the streaming equivalent of sandboxHtmlResponse.
 */
export const createHtmlSandboxTransformStream = () => {
	let isFirstChunk = true;

	const prefix = Buffer.from('<iframe srcdoc="', 'utf8');
	const suffix = Buffer.from(
		'" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-orientation-lock allow-pointer-lock allow-presentation allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" style="position:fixed; top:0; left:0; width:100vw; height:100vh; border:none; overflow:auto;" allowtransparency="true"></iframe>',
		'utf8',
	);

	return new Transform({
		transform(chunk: Buffer, encoding: string, done: TransformCallback) {
			try {
				chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as BufferEncoding);
				const escapedChunk = bufferEscapeHtml(chunk);
				const transformedChunk = isFirstChunk
					? Buffer.concat([prefix, escapedChunk])
					: escapedChunk;
				isFirstChunk = false;

				done(null, transformedChunk);
			} catch (error) {
				done(error as Error);
			}
		},

		flush(done: TransformCallback) {
			try {
				this.push(isFirstChunk ? Buffer.concat([prefix, suffix]) : suffix);
				done();
			} catch (error) {
				done(error as Error);
			}
		},
	});
};

/**
 * Checks if the given content type is something a browser might render
 * as HTML.
 */
export const isHtmlRenderedContentType = (contentType: string) => {
	const contentTypeLower = contentType.toLowerCase();

	return (
		// The content-type can also contain a charset, e.g. "text/html; charset=utf-8"
		contentTypeLower.startsWith('text/html') || contentTypeLower.startsWith('application/xhtml+xml')
	);
};
