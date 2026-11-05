import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
// 6h so a presigned page image survives a normal chat session before expiring.
const EXPIRES_IN = 6 * 60 * 60;

function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  if (!uri.startsWith('s3://')) return null;
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

/** Presign a full s3:// URI to an https URL the browser can load. Returns
 *  undefined for a missing/invalid URI or on any signing error (never throws). */
export async function presignS3Uri(
  uri?: string | null,
): Promise<string | undefined> {
  const parsed = uri ? parseS3Uri(uri) : null;
  if (!parsed) return undefined;
  try {
    // Cast: @aws-sdk/client-s3 and s3-request-presigner can resolve to separate
    // @smithy client declarations in the monorepo (private-field type skew).
    // Runtime is unaffected; this keeps the tsc gate green.
    return await getSignedUrl(
      s3 as unknown as Parameters<typeof getSignedUrl>[0],
      new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
      { expiresIn: EXPIRES_IN },
    );
  } catch (err) {
    console.error('[presign] failed for', uri, err);
    return undefined;
  }
}
