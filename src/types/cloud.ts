export type ProviderId =
  | '115'
  | 'baidu'
  | 'quark'
  | 'alipan'
  | 'tianyi'
  | 'xunlei';

export type CredentialMap = Record<string, string>;

export interface CloudAccount {
  id: string;
  providerId: ProviderId;
  displayName: string;
  credentials: CredentialMap;
  createdAt: number;
  updatedAt: number;
}

export interface CloudItem {
  id: string;
  providerId: ProviderId;
  accountId: string;
  parentId: string;
  name: string;
  isFolder: boolean;
  size: number;
  path?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  createdAt?: number;
  modifiedAt?: number;
  extra?: Record<string, unknown>;
}

export interface CloudFolder {
  id: string;
  name: string;
  path?: string;
}

export interface DownloadLink {
  url: string;
  headers?: Record<string, string>;
  expiresAt?: number;
}

export type CloudCapability =
  | 'search'
  | 'upload'
  | 'createFolder'
  | 'rename'
  | 'move'
  | 'copy'
  | 'delete';

export type CloudCapabilities = Record<CloudCapability, boolean>;

export interface CloudUploadSource {
  uri: string;
  name: string;
  size: number;
  mimeType?: string;
  createdAt?: number;
  modifiedAt?: number;
}

export interface UploadProgress {
  bytesSent: number;
  totalBytes: number;
  phase?: string;
}

export interface CloudSearchOptions {
  folder?: CloudFolder;
  limit?: number;
}

export interface CredentialField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
  secret?: boolean;
  multiline?: boolean;
  defaultValue?: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  shortName: string;
  color: string;
  icon: string;
  root: CloudFolder;
  authNote: string;
  fields: CredentialField[];
}

export interface CloudProvider {
  readonly definition: ProviderDefinition;
  readonly capabilities: CloudCapabilities;
  list(account: CloudAccount, folder: CloudFolder): Promise<CloudItem[]>;
  getDownloadLink(account: CloudAccount, item: CloudItem): Promise<DownloadLink>;
  search?(
    account: CloudAccount,
    keyword: string,
    options?: CloudSearchOptions,
  ): Promise<CloudItem[]>;
  upload?(
    account: CloudAccount,
    folder: CloudFolder,
    source: CloudUploadSource,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<void>;
  createFolder?(account: CloudAccount, parent: CloudFolder, name: string): Promise<void>;
  rename?(account: CloudAccount, item: CloudItem, name: string): Promise<void>;
  move?(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void>;
  copy?(account: CloudAccount, items: CloudItem[], destination: CloudFolder): Promise<void>;
  delete?(account: CloudAccount, items: CloudItem[]): Promise<void>;
}

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';

export interface DownloadResumeState {
  url: string;
  fileUri: string;
  isDirectory: boolean;
  headers?: Record<string, string>;
  resumeData?: string;
  expiresAt?: number;
}

export interface DownloadRecord {
  id: string;
  accountId: string;
  providerId: ProviderId;
  itemId: string;
  name: string;
  status: DownloadStatus;
  progress: number;
  bytesWritten: number;
  totalBytes: number;
  localUri?: string;
  resumeAvailable?: boolean;
  error?: string;
  createdAt: number;
}
