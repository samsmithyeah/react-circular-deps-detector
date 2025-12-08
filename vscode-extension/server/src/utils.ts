/**
 * Convert a file:// URI to a file system path
 */
export function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    // Handle Windows paths (file:///C:/...)
    let path = decodeURIComponent(uri.slice(7));
    if (path.match(/^\/[A-Za-z]:/)) {
      path = path.slice(1);
    }
    return path;
  }
  return uri;
}
