/** feature 的公开出口（D-05 §3.1）。 */
export { FolderTree } from './FolderTree';
export {
  useFoldersQuery,
  useCreateFolderMutation,
  useRenameFolderMutation,
  useDeleteFolderMutation,
  useMoveNoteMutation,
  buildTree,
  flattenFolders,
  normalizeFolders,
  type FolderDto,
  type FolderNode,
} from './api';
