export interface BrowserOpenRequest {
  id: string;
  url?: string;
  label?: string;
  device?: string;
}

export interface ExternalChatPrompt {
  id: string;
  text: string;
}
