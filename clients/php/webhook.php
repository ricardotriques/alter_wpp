<?php
/**
 * Exemplo de receptor de webhook (serve para o motor alternativo e para a Cloud API oficial).
 * Configure a URL deste arquivo como webhook_url da linha.
 */
require __DIR__ . '/WhatsAppEngine.php';

const WEBHOOK_SECRET = 'cole-aqui-o-webhook_secret-da-linha';

// Verificação de assinatura do endpoint (só a API oficial da Meta usa este GET)
if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['hub_challenge'])) {
    echo $_GET['hub_challenge'];
    exit;
}

$raw = file_get_contents('php://input');
if (!WhatsAppEngine::verifySignature($raw, $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? null, WEBHOOK_SECRET)) {
    http_response_code(401);
    exit('assinatura inválida');
}

// Responda rápido (o motor espera até 10 s e tenta de novo se falhar)
http_response_code(200);
echo 'ok';
if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

$payload = json_decode($raw, true);
foreach ($payload['entry'] ?? [] as $entry) {
    foreach ($entry['changes'] ?? [] as $change) {
        $value = $change['value'] ?? [];
        $phoneNumberId = $value['metadata']['phone_number_id'] ?? null;

        // Mensagens recebidas
        foreach ($value['messages'] ?? [] as $msg) {
            $from = $msg['from'];
            $name = $value['contacts'][0]['profile']['name'] ?? '';
            switch ($msg['type']) {
                case 'text':
                    $texto = $msg['text']['body'];
                    // ... sua lógica (URA, CRM, confirmação de presença etc.)
                    break;
                case 'interactive':
                    $escolha = $msg['interactive']['button_reply']['id'] ?? $msg['interactive']['list_reply']['id'] ?? null;
                    // ex.: 'sim' / 'nao' de um convite
                    break;
                case 'image':
                case 'audio':
                case 'video':
                case 'document':
                    $mediaId = $msg[$msg['type']]['id'];
                    // [$bin, $mime] = $wa->downloadMedia($mediaId);
                    break;
            }
        }

        // Status das mensagens enviadas: sent / delivered / read / failed
        foreach ($value['statuses'] ?? [] as $st) {
            // atualize seu banco: $st['id'], $st['status'], $st['recipient_id']
        }

        // Evento exclusivo do motor alternativo: conexão da linha
        if ($change['field'] === 'connection') {
            $estado = $value['connection']['state']; // open | qr | logged_out | reconnecting | qr_timeout
            // ex.: alertar o admin quando cair (logged_out)
        }
    }
}
