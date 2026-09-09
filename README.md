# Painel de Protótipos

Página local pra parar de perder a conta de quantos protótipos estão rodando e em qual porta.
Descobre sozinho qualquer pasta em `Documents\` que tenha um `_serve.ps1`, mostra se está no
ar, e deixa subir/parar cada um pelo clique.

## Rodar

```
node server.mjs
```

Abre em <http://localhost:8700/>. Só escuta em `127.0.0.1` (não fica exposto na rede). Sem
dependências, Node 18+.

## Como funciona

- **Descoberta automática**: a cada carregamento da página, escaneia as pastas de primeiro nível
  dentro de `Documents\` procurando `_serve.ps1`. Novo protótipo estático aparece sozinho, não
  precisa cadastrar.
- **Descoberta manual (`projects.json`)**: protótipo que não segue o padrão `_serve.ps1` direto
  em `Documents\` (pasta aninhada, outro tipo de servidor) entra aqui à mão. Hoje só o
  **Radar de Editais** (Next.js, dentro do vault `Editais Licitacao`, sobe com `npm run dev`).
  Pra adicionar outro assim: uma entrada `{name, title, path, port, kind:"npm", startArgs}`.
- **Porta**: pro `_serve.ps1`, lida do próprio script (`$port = ...` ou `localhost:NNNN` direto).
  Pro `kind:"npm"`, vem do `projects.json` e é passada pro comando (`-p <porta>`).
- **Status**: tenta conectar na porta. Não distingue *quem* está respondendo, só *se* tem algo
  respondendo — se dois projetos apontarem pra mesma porta por engano, um vai aparecer "no ar"
  mesmo sendo o outro (foi exatamente o que aconteceu entre `osm-demo-prototipo` e
  `programador-prototipo`, os dois com porta 8744 até eu corrigir).
- **Subir**: `_serve.ps1` sobe via `powershell -ExecutionPolicy Bypass -File _serve.ps1`; `npm`
  sobe via `npm.cmd run dev -- -p <porta>` (precisa de `shell:true`, `.cmd` não é executável de
  verdade). Dois detalhes de Windows que custaram um tempo de debug:
  - `detached: true` no Node faz o Windows PowerShell morrer na hora (código 0, sem saída
    nenhuma), provável efeito de `CREATE_NEW_PROCESS_GROUP` sem console. **Não uso** `detached`;
    sem ele o processo continua rodando normalmente depois da requisição HTTP terminar.
  - Um `.cmd` (`npm.cmd`) dá `EINVAL` síncrono sem `shell:true` — e derrubava o painel inteiro
    até eu envolver o spawn em try/catch e pôr uma rede de segurança (`uncaughtException`) no
    processo todo.
- **Parar**: só funciona pros processos que o próprio painel iniciou nesta sessão (guarda o
  processo em memória). Um servidor aberto direto no terminal não pode ser parado por aqui, o
  botão fica desabilitado com dica explicando isso. Quando para de verdade, usa
  `taskkill /pid <pid> /t /f` (a árvore inteira, não só o processo de topo) — `child.kill()`
  sozinho derruba só o `cmd.exe`/`npm.cmd` de cima e o `next dev` de baixo fica órfão, vivo,
  ocupando a porta.
- **Deploy**: campo de URL e nota são só um registro manual (`registry.json`, `.gitignore`d se
  você inicializar git aqui), o painel não confere Vercel nem nada, você preenche quando publica.

## Projetos encontrados hoje

| Pasta | Porta | Tipo | Deploy |
|---|---|---|---|
| `croqui-prototipo` | 8743 | `_serve.ps1` | Vercel, com senha (`middleware.js`) — URL a preencher |
| `osm-demo-prototipo` | 8745 | `_serve.ps1` | nenhum ainda |
| `programador-prototipo` | 8744 | `_serve.ps1` | nenhum ainda |
| Radar de Editais (`Editais Licitacao\Editais Licitacao\site`) | 3010 | `npm run dev` (Next.js) | nenhum ainda — e localmente pede login (`/entrar`), tem sistema de auth próprio em `src/lib/auth.ts` |
