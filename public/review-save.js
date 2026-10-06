// 保存先の確定を補正より先に行い、元画像は保存へ渡さない。
export async function prepareReviewSave({ draft, crop, selectDestination }) {
  if (!draft.resolve()) { selectDestination(); return null; }
  return crop.prepareSave();
}
