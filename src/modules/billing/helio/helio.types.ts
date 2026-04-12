export interface HelioWebhookPayload {
  event: string;
  transactionId: string;
  paylinkId: string;
  protocolPubkey: string;
  tier?: number | string;
  solanaTxSignature?: string;
  customer?: {
    walletAddress?: string;
    email?: string;
  };
  metadata?: {
    protocol_id?: string;
    herald_wallet?: string;
    [key: string]: any;
  };
  [key: string]: any;
}
