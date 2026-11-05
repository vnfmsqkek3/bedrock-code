import { describe, it, expect } from 'vitest';
import { buildDocTree, countDocs, collectDocs } from './index';
import type { Document } from '../../types/project';

function doc(id: string, extra: Partial<Document>): Document {
  return {
    document_id: id,
    name: `${id}.pdf`,
    file_type: 'application/pdf',
    file_size: 1,
    status: 'completed',
    use_bda: false,
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

describe('buildDocTree', () => {
  it('nests documents by folder_path', () => {
    const docs = [
      doc('a', { folder_path: '인사/규정' }),
      doc('b', { folder_path: '인사/규정' }),
      doc('c', { folder_path: '재무/2024' }),
    ];
    const root = buildDocTree(docs, 'folder');
    expect(countDocs(root)).toBe(3);
    const hr = root.children.get('인사')!;
    expect(hr.path).toBe('인사');
    expect(countDocs(hr)).toBe(2);
    expect(hr.children.get('규정')!.docs).toHaveLength(2);
  });

  it('groups path-less documents under 미분류', () => {
    const root = buildDocTree([doc('x', { folder_path: '' })], 'folder');
    expect(root.children.get('미분류')!.docs).toHaveLength(1);
  });

  it('uses category_path in category mode', () => {
    const root = buildDocTree(
      [doc('y', { category_path: '법무/계약', folder_path: '무관/경로' })],
      'category',
    );
    expect(root.children.get('법무')!.children.get('계약')!.docs).toHaveLength(
      1,
    );
  });

  it('collectDocs flattens a whole subtree', () => {
    const docs = [
      doc('a', { folder_path: '인사/규정' }),
      doc('b', { folder_path: '인사/급여' }),
      doc('c', { folder_path: '재무' }),
    ];
    const root = buildDocTree(docs, 'folder');
    const hr = root.children.get('인사')!;
    expect(collectDocs(hr).map((d) => d.document_id).sort()).toEqual(['a', 'b']);
    expect(collectDocs(root)).toHaveLength(3);
  });
});
