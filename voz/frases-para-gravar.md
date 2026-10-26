# Frases para gravar a voz do Luk

Leia no seu ritmo normal de conversa. **Não capriche na dicção** — o clone copia
o jeito de falar, então falar "bonito demais" faz o Luk soar artificial.

Deixe cerca de um segundo de silêncio entre uma frase e outra. Eu aparo depois.

---

### 1
> Bom dia, Lucas. São nove e quarenta, e o servidor está estável desde ontem à noite.

### 2
> Encontrei três mensagens novas, duas delas marcadas como urgentes.

### 3
> A reunião de quinta foi remarcada para a próxima terça-feira, às catorze horas.

### 4
> Você quer que eu prepare um resumo antes, ou prefere que eu mande direto?

### 5
> O relatório que você pediu ficou pronto, mas achei uma inconsistência nos números de março.

### 6
> Separei os arquivos por pasta: contratos, planilhas e rascunhos.

### 7
> Houve um erro no carregamento, mas já corrigi e nada se perdeu.

### 8
> Tenho duas opções para te mostrar, e nenhuma delas atrapalha o cronograma.

### 9
> Olha só: o João ligou duas vezes, e a Giulia mandou mensagem no final da tarde.

### 10
> Amanhã cedo eu te lembro. Está tudo certo por aqui, qualquer coisa é só chamar.

---

## Por que essas frases

Não são aleatórias. Cada uma carrega sons que o português tem e que o clone
precisa ouvir pelo menos uma vez:

| som | onde aparece |
|---|---|
| nasal `ão` / `õe` | s**ão**, reuni**ão**, Jo**ão**, opç**õe**s |
| nasal `ã` / `nh` | ama**nh**ã, ne**nh**uma |
| R forte (`rr`, R inicial) | e**rr**o, ca**rr**egamento, **r**elatório, **r**esumo |
| R brando | p**r**epa**r**e, p**r**onto |
| `lh` | o**lh**a, plani**lh**as |
| `ch` / `x` | a**ch**ei, pró**x**ima |
| vogais abertas e fechadas | **é** / **ê**, s**ó** / pr**o**nto |
| números falados | nove e quarenta, três, catorze |
| pergunta | frase 4 |
| lista com pausas | frase 6 |

E o registro é o do assistente — informando, avisando, perguntando. O clone
copia o **estilo** junto com o timbre, então gravar no tom que o Luk vai usar
sai melhor do que ler um texto qualquer.

## Como gravar

| | |
|---|---|
| formato | **WAV** (ou FLAC). Nada de MP3 — é o que limitou todas as rodadas até agora |
| taxa | 44,1 ou 48 kHz. Mono serve |
| ambiente | silencioso. Desligue ventilador e ar-condicionado |
| microfone | uns 20 cm, levemente de lado — evita o estouro do "P" e do "B" |
| nível | picos perto de −6 dB. Não deixe estourar; corte é irreversível |
| ritmo | o seu normal. Nem devagar, nem declamado |

Total: entre 40 e 60 segundos de fala. Mais que isso não melhora muito o clone.

### ⚠️ O Gravador de Voz do Windows não serve

Ele salva em `.m4a`, que é comprimido. Jogaria fora exatamente a faixa que o
clone usa — o mesmo problema que já limitou as rodadas anteriores.

### Com o que você já tem: OBS Studio + o microfone USB

O laptop tem **OBS Studio** instalado e um **Light Up USB Streaming Mic**.
Essa dupla grava sem compressão nenhuma.

1. **Configurações → Saída → Gravação**
   - Formato de gravação: **WAV**
   - Codificador de áudio: **PCM** (sem compressão)
2. **Configurações → Áudio**
   - Taxa de amostragem: **48 kHz**
   - Canais: **Mono**
3. No mixer, deixe só o **Mic/Aux** ativo. **Silencie o áudio do desktop** —
   senão entra som do sistema junto.
4. Fale uma frase de teste e olhe o medidor: os picos devem bater perto de
   **−6 dB**, na faixa amarela. Se encostar no vermelho, baixe o ganho.
5. Grave tudo num arquivo só, com um segundo de pausa entre as frases. Eu aparo.

**Alternativa:** Audacity (grátis) — gravar, depois `Arquivo → Exportar →
Exportar como WAV`, 16 bits PCM.

### Se for gerar em vez de gravar

Vale igual, mas com duas ressalvas:

- O teto de qualidade passa a ser o da ferramenta que gerou.
- **Exporte sem compressão.** Clonar a partir de um MP3 de uma voz que já era
  sintética perde em dois lugares, e os dois são irreversíveis.

## Depois

Joga os arquivos numa pasta e me avisa. Eu rodo:

```bash
bash voz/avaliar.sh <pasta>
```

Ele mede cada arquivo, diz quais servem e por quê, prepara as referências do
jeito que o modelo quer, e gera uma amostra de cada para você comparar de ouvido.
