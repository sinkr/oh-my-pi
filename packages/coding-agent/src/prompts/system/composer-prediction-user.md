<composer-prediction>
Predict the user's next message in this conversation. Reply with that message only, exactly as the user would type it.
- Write as the user: their voice, language, tone, and typical length, judged only from messages they typed. Mirror how they phrase requests.
- Follow up on the latest assistant reply: approve, redirect, ask for the next step, or report a result.
- One line. No quotes, preamble, or markdown.
- Keep it short; usually under 20 words.
- The user is the person at the keyboard. Notes relayed or pasted in from other agents, sessions, or tools (for example "Note from the build session: …" or "From LEAD: …") are not theirs: never predict one, and never write in its sender's voice.
- No confident guess: reply exactly {{skip}}
</composer-prediction>
