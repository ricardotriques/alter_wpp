<?php
/**
 * Cliente PHP do motor WhatsApp alternativo.
 *
 * Fala o mesmo "idioma" da WhatsApp Cloud API da Meta. Para migrar uma solução
 * para a API oficial no futuro, troque apenas $baseUrl, $phoneNumberId e $token:
 *
 *   // motor alternativo
 *   $wa = new WhatsAppEngine('https://wa.seudominio.com.br', 'festavibe-01', 'wae_...');
 *   // API oficial da Meta
 *   $wa = new WhatsAppEngine('https://graph.facebook.com', '1234567890', 'EAAG...');
 *
 * Requer PHP 8.1+ com a extensão curl.
 */
final class WhatsAppEngine
{
    public function __construct(
        private string $baseUrl,
        private string $phoneNumberId,
        private string $token,
        private string $version = 'v21.0',
        private int $timeout = 20,
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /** Texto simples. Retorna o id da mensagem (wamid). */
    public function sendText(string $to, string $text, ?string $replyTo = null): string
    {
        $body = ['type' => 'text', 'text' => ['body' => $text, 'preview_url' => false]];
        if ($replyTo) $body['context'] = ['message_id' => $replyTo];
        return $this->sendMessage($to, $body);
    }

    /** Imagem, vídeo, áudio, documento ou figurinha a partir de uma URL pública. */
    public function sendMedia(string $to, string $type, string $link, ?string $caption = null, ?string $filename = null): string
    {
        $media = ['link' => $link];
        if ($caption !== null) $media['caption'] = $caption;
        if ($filename !== null) $media['filename'] = $filename;
        return $this->sendMessage($to, ['type' => $type, $type => $media]);
    }

    /**
     * Botões de resposta (até 3 na API oficial). No motor alternativo viram
     * opções numeradas; a resposta chega no webhook como interactive.button_reply.
     *
     * @param array<string,string> $buttons  ['id' => 'Título', ...]
     */
    public function sendButtons(string $to, string $text, array $buttons, ?string $header = null, ?string $footer = null): string
    {
        $interactive = [
            'type' => 'button',
            'body' => ['text' => $text],
            'action' => ['buttons' => array_map(
                fn ($id, $title) => ['type' => 'reply', 'reply' => ['id' => (string) $id, 'title' => $title]],
                array_keys($buttons),
                $buttons,
            )],
        ];
        if ($header) $interactive['header'] = ['type' => 'text', 'text' => $header];
        if ($footer) $interactive['footer'] = ['text' => $footer];
        return $this->sendMessage($to, ['type' => 'interactive', 'interactive' => $interactive]);
    }

    /**
     * Template com parâmetros {{1}}, {{2}}... no corpo.
     * No motor alternativo o template é cadastrado em POST /admin/templates.
     */
    public function sendTemplate(string $to, string $name, array $bodyParams = [], string $lang = 'pt_BR', array $headerParams = []): string
    {
        $components = [];
        $toParams = fn (array $p) => array_map(fn ($v) => ['type' => 'text', 'text' => (string) $v], array_values($p));
        if ($headerParams) $components[] = ['type' => 'header', 'parameters' => $toParams($headerParams)];
        if ($bodyParams) $components[] = ['type' => 'body', 'parameters' => $toParams($bodyParams)];
        return $this->sendMessage($to, [
            'type' => 'template',
            'template' => ['name' => $name, 'language' => ['code' => $lang], 'components' => $components],
        ]);
    }

    public function sendLocation(string $to, float $lat, float $lng, ?string $name = null, ?string $address = null): string
    {
        return $this->sendMessage($to, ['type' => 'location', 'location' => array_filter(
            ['latitude' => $lat, 'longitude' => $lng, 'name' => $name, 'address' => $address],
            fn ($v) => $v !== null,
        )]);
    }

    public function react(string $to, string $messageId, string $emoji): string
    {
        return $this->sendMessage($to, ['type' => 'reaction', 'reaction' => ['message_id' => $messageId, 'emoji' => $emoji]]);
    }

    public function markAsRead(string $messageId): void
    {
        $this->request('POST', "/{$this->version}/{$this->phoneNumberId}/messages", [
            'messaging_product' => 'whatsapp',
            'status' => 'read',
            'message_id' => $messageId,
        ]);
    }

    /** Baixa uma mídia recebida (id que veio no webhook). Retorna [conteúdo, mime]. */
    public function downloadMedia(string $mediaId): array
    {
        $info = $this->request('GET', "/{$this->version}/{$mediaId}");
        $ch = curl_init($info['url']);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ["Authorization: Bearer {$this->token}"],
            CURLOPT_TIMEOUT => 60,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        $bin = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($bin === false || $code >= 400) throw new RuntimeException("Falha ao baixar mídia ($code)");
        return [$bin, $info['mime_type'] ?? 'application/octet-stream'];
    }

    /** Envio genérico no formato da Cloud API. */
    public function sendMessage(string $to, array $body): string
    {
        $res = $this->request('POST', "/{$this->version}/{$this->phoneNumberId}/messages", [
            'messaging_product' => 'whatsapp',
            'recipient_type' => 'individual',
            'to' => preg_replace('/\D/', '', $to),
        ] + $body);
        return $res['messages'][0]['id'] ?? '';
    }

    private function request(string $method, string $path, ?array $json = null): array
    {
        $ch = curl_init($this->baseUrl . $path);
        $headers = ["Authorization: Bearer {$this->token}", 'Accept: application/json'];
        $opts = [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_TIMEOUT => $this->timeout];
        if ($json !== null) {
            $headers[] = 'Content-Type: application/json';
            $opts[CURLOPT_POSTFIELDS] = json_encode($json, JSON_UNESCAPED_UNICODE);
        }
        $opts[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $opts);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($raw === false) throw new RuntimeException("Erro de rede: $err");
        $data = json_decode($raw, true) ?? [];
        if ($code >= 400) {
            $msg = $data['error']['message'] ?? "HTTP $code";
            throw new WhatsAppEngineException($msg, (int) ($data['error']['code'] ?? 0), $code);
        }
        return $data;
    }

    /**
     * Valida a assinatura X-Hub-Signature-256 de um webhook recebido.
     * $secret = webhook_secret da linha (no motor) ou App Secret (na Meta).
     */
    public static function verifySignature(string $rawBody, ?string $header, string $secret): bool
    {
        if (!$header) return false;
        return hash_equals('sha256=' . hash_hmac('sha256', $rawBody, $secret), $header);
    }
}

final class WhatsAppEngineException extends RuntimeException
{
    public function __construct(string $message, int $code, public readonly int $httpStatus)
    {
        parent::__construct($message, $code);
    }
}
