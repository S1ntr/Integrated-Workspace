export interface BrowserOpenRequest {
  id: string;
  url?: string;
  label?: string;
  device?: string;
  mode?: "app" | "web";
}

export interface ChatAttachment {
  id: string;
  type: "image" | "file" | "browser-selection";
  name: string;
  url?: string;
  path?: string;
  mime?: string;
  detail?: string;
  content?: string;
}

export interface ExternalChatPrompt {
  id: string;
  text: string;
  attachments?: ChatAttachment[];
}
