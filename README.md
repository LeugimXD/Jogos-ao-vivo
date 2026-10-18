# Jogos ao Vivo

Agenda, placar ao vivo e onde assistir no Brasil: Brasileirão, Premier League, Champions League, NBA e NFL.

- Os jogos vêm de um banco no Supabase (projeto `jogos-ao-vivo`), que se atualiza sozinho a partir do placar público da ESPN: agenda dos próximos 7 dias a cada 3 horas e, durante os jogos, placar a cada minuto.
- O app recebe as mudanças em tempo real e pisca a linha quando sai gol/ponto.
- Tela do jogo: resumo com lances (gols, cartões, substituições) ou pontuações, escalações no campinho, estatísticas, tabela e confronto/forma recente. Esses detalhes vêm da função `espn` (pasta `supabase/functions/espn`), que busca na ESPN sob demanda e guarda em cache.
- Campeonatos (jogos dos próximos 14 dias, resultados e tabela), página de cada time (próximos jogos, resultados e posição) e busca de times.
- "Onde ver" usa os canais padrão de cada campeonato; dá para cravar o canal de um jogo específico na coluna `channels_override` da tabela `games`.

Para instalar no iPhone: abra o endereço no Safari → Compartilhar → Adicionar à Tela de Início. No Android: menu do Chrome → Instalar app.
