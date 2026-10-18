import type { Model } from "@oh-my-pi/pi-catalog/types";
import { readSseJson } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { factoryDroidImageRoute } from "../providers/factory-droid";
import { googleStreamChunkError } from "../providers/google-shared";
import editDirective from "./factory-droid-edit-directive.md" with { type: "text" };
import generateDirective from "./factory-droid-generate-directive.md" with { type: "text" };
import { type GeminiImageResponse, geminiImageContents, geminiImageResult } from "./google-generative-ai";
import { decodeImageResponse, errorMessage, ImageApiError, parseImageApiResponse, validateImageInput } from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

/** Reference images Factory's JSON edits contract accepts per request. */
export const FACTORY_DROID_MAX_EDIT_IMAGES = 16;
/** Decoded bytes the CLI accepts per reference image. */
export const FACTORY_DROID_MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const FACTORY_DROID_EDIT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"];

type GeminiImageChunk = GeminiImageResponse & {
	error?: Parameters<typeof googleStreamChunkError>[0];
	promptFeedback?: { blockReason?: string };
};

/** Reject references the proxy would refuse, before any bytes leave. */
function validateReferences(model: Model, request: ImageGenerationRequest, openAIEdit: boolean): void {
	const inputImages = request.inputImages ?? [];
	if (openAIEdit && inputImages.length > FACTORY_DROID_MAX_EDIT_IMAGES) {
		throw new AIError.ValidationError(
			`${model.provider} image edits accept up to ${FACTORY_DROID_MAX_EDIT_IMAGES} reference images; got ${inputImages.length}`,
		);
	}
	for (const [index, image] of inputImages.entries()) {
		validateImageInput(image);
		const bytes = Buffer.byteLength(image.data, "base64");
		if (bytes > FACTORY_DROID_MAX_REFERENCE_BYTES) {
			throw new AIError.ValidationError(
				`${model.provider} reference image ${index + 1} is ${bytes} bytes; the limit is ${FACTORY_DROID_MAX_REFERENCE_BYTES} (5 MiB)`,
			);
		}
		if (openAIEdit && !FACTORY_DROID_EDIT_MEDIA_TYPES.includes(image.mimeType)) {
			throw new AIError.ValidationError(
				`${model.provider} image edits accept ${FACTORY_DROID_EDIT_MEDIA_TYPES.join(", ")} references; got ${image.mimeType}`,
			);
		}
	}
}

/**
 * Factory Droid `generate_image` transport, mirroring the CLI: GPT Image
 * models call the proxy's OpenAI Images routes, a prompt alone on
 * `/images/generations` and reference images inline on `/images/edits`
 * (Factory converts `input_images` to upstream multipart); Gemini image
 * models call the native Gemini route asking for TEXT and IMAGE output. Both
 * carry chat's client identity. The Droid identity rides the proxy-only
 * `instructions` field, or opens the Gemini system instruction ahead of the
 * CLI's generate or edit directive.
 *
 * A 200 without an image (a Gemini prompt block, an empty data array) throws
 * a response error, which ends the tool's chain like other malformed
 * responses; HTTP rejections throw provider HTTP errors, which advance it.
 */
export async function generateFactoryDroidImage(
	model: Model<"factory-droid-agent">,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const inputImages = request.inputImages ?? [];
	const result = await withAuth(
		options.apiKey,
		async (token): Promise<ImageGenerationResult & { blockReason?: string }> => {
			const route = factoryDroidImageRoute(model, token, options.sessionId);
			validateReferences(model, request, route.wire === "openai-responses" && inputImages.length > 0);
			const headers = { ...route.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
			const wireModel = model.requestModelId ?? model.id;
			if (route.wire === "google-generate") {
				const directive = (inputImages.length > 0 ? editDirective : generateDirective).trim();
				const response = await fetchImpl(`${route.baseUrl}/generate`, {
					method: "POST",
					headers: { ...headers, Accept: "*/*" },
					body: JSON.stringify({
						model: wireModel,
						contents: geminiImageContents(request),
						systemInstruction: { parts: [{ text: `${route.identity} ${directive}` }] },
						generationConfig: {
							temperature: 1,
							topP: 0.95,
							topK: 64,
							responseModalities: ["TEXT", "IMAGE"],
							...(request.aspectRatio || request.imageSize
								? { imageConfig: { aspectRatio: request.aspectRatio, imageSize: request.imageSize } }
								: {}),
						},
					}),
					signal: options.signal,
				});
				if (!response.ok) {
					throw new ImageApiError(
						`${model.provider}/${model.id} image request failed (${response.status}): ${errorMessage(await response.text())}`,
						response.status,
						{ headers: response.headers },
					);
				}
				if (!response.body) {
					throw new AIError.ProviderResponseError("Factory Gemini image response has no body", {
						provider: model.provider,
						kind: "empty-body",
					});
				}
				const chunks: GeminiImageChunk[] = [];
				let blockReason: string | undefined;
				for await (const chunk of readSseJson<GeminiImageChunk>(response.body, options.signal)) {
					if (chunk.error) throw googleStreamChunkError(chunk.error, model.provider);
					blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
					chunks.push(chunk);
				}
				return { ...geminiImageResult(chunks), blockReason };
			}

			const body = {
				model: wireModel,
				prompt: request.prompt,
				n: request.count ?? 1,
				instructions: route.identity,
				...(inputImages.length > 0 && {
					input_images: inputImages.map(image => ({ media_type: image.mimeType, data: image.data })),
				}),
			};
			const response = await fetchImpl(
				`${route.baseUrl}${inputImages.length > 0 ? "/images/edits" : "/images/generations"}`,
				{ method: "POST", headers, body: JSON.stringify(body), signal: options.signal },
			);
			return decodeImageResponse(await parseImageApiResponse(model, response), fetchImpl, options.signal);
		},
		{ signal: options.signal },
	);
	if (result.images.length > 0) {
		const { blockReason: _blockReason, ...images } = result;
		return images;
	}
	const detail = result.blockReason
		? `the prompt was blocked (${result.blockReason})`
		: result.text
			? `the model answered with text only: ${result.text}`
			: "the response carried no image";
	throw new AIError.ProviderResponseError(`${model.provider}/${model.id} returned no image: ${detail}`, {
		provider: model.provider,
		kind: result.blockReason ? "content-blocked" : "empty-output",
	});
}
