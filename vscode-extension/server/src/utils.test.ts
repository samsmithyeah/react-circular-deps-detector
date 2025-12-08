import { fileUriToPath } from './utils';

describe('Utils', () => {
  describe('fileUriToPath', () => {
    it('should convert Unix file URI to path', () => {
      const uri = 'file:///Users/test/project/file.ts';
      const result = fileUriToPath(uri);
      expect(result).toBe('/Users/test/project/file.ts');
    });

    it('should convert Windows file URI to path', () => {
      const uri = 'file:///C:/Users/test/project/file.ts';
      const result = fileUriToPath(uri);
      expect(result).toBe('C:/Users/test/project/file.ts');
    });

    it('should decode URI-encoded characters', () => {
      const uri = 'file:///Users/test/my%20project/file.ts';
      const result = fileUriToPath(uri);
      expect(result).toBe('/Users/test/my project/file.ts');
    });

    it('should return non-URI strings as-is', () => {
      const path = '/Users/test/project/file.ts';
      const result = fileUriToPath(path);
      expect(result).toBe(path);
    });
  });
});
