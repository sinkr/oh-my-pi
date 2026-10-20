import { pdfToMarkdown } from "@oh-my-pi/pi-natives";
import type { ConversionResult, Converter, StreamInfo } from "../../types";

const EXTENSIONS = [".pdf"];
const MIMETYPES = ["application/pdf", "application/x-pdf"];

/** Converts PDF buffers to Markdown through the native `pdf-inspector` bridge. */
export class PdfConverter implements Converter {
	name = "pdf";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
			return true;
		}
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) {
			return true;
		}
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const result = await pdfToMarkdown(input);
		const notice =
			result.pagesNeedingOcr.length > 0
				? `Text extraction is incomplete for PDF pages ${result.pagesNeedingOcr.join(", ")}. If this PDF is a file on disk, append \`:page<N>.png\` to its file path to read a page as an image (e.g. \`doc.pdf:page${result.pagesNeedingOcr[0]}.png\`).`
				: undefined;

		const conversion: ConversionResult = {
			markdown: notice ? [result.markdown, notice].filter(Boolean).join("\n\n") : result.markdown,
		};
		if (result.title !== undefined) conversion.title = result.title;
		return conversion;
	}
}
