import type { Model } from "@oh-my-pi/pi-catalog/types";
import { readSseJson } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { factoryDroidImageRoute } from "../providers/factory-droid";
import { googleStreamChunkError } from "../providers/google-shared";
import { type GeminiImageResponse, geminiImageContents, geminiImageResult } from "./google-generative-ai";
import { decodeImageResponse, errorMessage, ImageApiError, parseImageApiResponse, validateImageInput } from "./shared";
import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

/** Reference images Factory's JSON edits contract accepts per request. */
export const FACTORY_DROID_MAX_EDIT_IMAGES = 16;
const FACTORY_DROID_EDIT_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"];

type GeminiImageChunk = GeminiImageResponse & {
	error?: Parameters<typeof googleStreamChunkError>[0];
	promptFeedback?: { blockReason?: string };
};

/**
 * Factory Droid `generate_image` transport, mirroring the CLI: GPT Image
 * models call the proxy's OpenAI Images routes, a prompt alone on
 * `/images/generations` and reference images inline on `/images/edits`
 * (Factory converts `input_images` to upstream multipart); Gemini image
 * models call the native Gemini route asking for TEXT and IMAGE output. Both
 * carry chat's client identity, and the Droid identity rides the proxy-only
 * `instructions` field or the Gemini system instruction.
 */
export async function generateFactoryDroidImage(
	model: Model<"factory-droid-agent">,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const inputImages = request.inputImages ?? [];
	return withAuth(
		options.apiKey,
		async token => {
			const route = factoryDroidImageRoute(model, token, options.sessionId);
			const headers = { ...route.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
			const wireModel = model.requestModelId ?? model.id;
			if (route.wire === "google-generate") {
				const response = await fetchImpl(`${route.baseUrl}/generate`, {
					method: "POST",
					headers: { ...headers, Accept: "*/*" },
					body: JSON.stringify({
						model: wireModel,
						contents: geminiImageContents(request),
						systemInstruction: { parts: [{ text: route.identity }] },
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
				const result = geminiImageResult(chunks);
				// A blocked prompt is a 200 with no candidates; say why instead of returning nothing.
				if (result.images.length === 0 && blockReason && !result.text) {
					result.text = `Gemini blocked the prompt (${blockReason}).`;
				}
				return result;
			}

			if (inputImages.length > FACTORY_DROID_MAX_EDIT_IMAGES) {
				throw new AIError.ValidationError(
					`${model.provider} image edits accept up to ${FACTORY_DROID_MAX_EDIT_IMAGES} reference images; got ${inputImages.length}`,
				);
			}
			for (const image of inputImages) {
				validateImageInput(image);
				if (!FACTORY_DROID_EDIT_MEDIA_TYPES.includes(image.mimeType)) {
					throw new AIError.ValidationError(
						`${model.provider} image edits accept ${FACTORY_DROID_EDIT_MEDIA_TYPES.join(", ")} references; got ${image.mimeType}`,
					);
				}
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
}
