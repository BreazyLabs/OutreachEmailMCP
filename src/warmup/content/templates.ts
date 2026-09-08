/**
 * Bundled fallback corpus. Used whenever the LLM pool is empty, the API is
 * down, or no endpoint is configured. Turns are written without greeting or
 * sign-off — those come from the personas at send time — and contain no
 * links, addresses or numbers that could read as marketing.
 */

export interface ScriptTemplate {
  language: string;
  register: 'casual' | 'business';
  topic: string;
  subject: string;
  turns: string[];
}

export const TEMPLATE_SCRIPTS: ScriptTemplate[] = [
  // ---------------------------------------------------------------- English
  {
    language: 'en', register: 'business', topic: 'meeting follow-up', subject: 'Quick follow-up from Tuesday',
    turns: [
      'Thanks again for taking the time on Tuesday. I went back over my notes and I think the plan we sketched out holds up. The one thing I would add is a short check-in halfway through so nobody is surprised at the end.',
      'Agreed, a halfway check-in makes sense. Do you want to own the agenda for that one or should I? Either is fine with me, I just want it on the calendar before it slips.',
      'Happy to take it. I will send something over once I have the dates lined up.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'document review', subject: 'Draft for your review',
    turns: [
      'I have attached nothing this time, on purpose, because I wanted to ask first: are you the right person to look over the onboarding draft, or has that moved to someone else on your side?',
      'Still me for now. Send it when it is ready and I will get you comments by the end of the week. If it is long, a summary at the top helps me a lot.',
      'Will do, summary at the top. Thanks for the quick answer.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'catching up', subject: 'Long time',
    turns: [
      'It has been a while. I saw your name come up the other day and realised we never did that coffee we kept talking about. How have things been on your end?',
      'Busy, in a good way. The new role took a few months to settle into but it is starting to feel normal. Coffee sounds great, I am around most of next week.',
      'Next week works. I will look at my calendar tomorrow and suggest a couple of slots.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'invoice question', subject: 'Question about last month',
    turns: [
      'Small question about the last statement: one of the line items looks like it was counted twice. Could be my reading of it. Would you mind checking on your side before I raise it with finance?',
      'You are right, it was duplicated. Already flagged it and a corrected copy is on its way. Sorry about that, and thanks for catching it before it went further.',
      'No problem at all, these things happen. Thanks for sorting it so quickly.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'recommendation', subject: 'That book you mentioned',
    turns: [
      'I finally picked up the book you recommended at lunch. About halfway through and it is much better than I expected, the middle section especially.',
      'Glad it landed. The ending is a bit abrupt, fair warning, but the ideas in the middle stuck with me for weeks. Let me know what you think when you finish.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'scheduling', subject: 'Moving our call',
    turns: [
      'Something came up on Thursday morning and I need to move our call. Would the same time on Friday work, or early next week if that is easier for you?',
      'Friday is fine. Same time, same link. If anything changes on my side I will let you know by Thursday evening.',
      'Perfect, see you Friday.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'introduction', subject: 'Intro from the workshop',
    turns: [
      'We spoke briefly after the workshop last week, you were the one asking about the rollout timeline. I said I would follow up, so here I am. Happy to share what we learned if it is useful.',
      'Yes, I remember. It would be useful, especially the part about how you handled the first few weeks. No rush, whenever you have a moment.',
      'I will write it up properly rather than dumping half-thoughts on you. Give me a few days.',
      'Sounds good, thank you.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'weekend plans', subject: 'Weekend',
    turns: [
      'Any plans for the weekend? We are thinking of heading out of the city if the weather holds, otherwise it will be a very boring couple of days of tidying the garage.',
      'Nothing fixed yet. A friend is visiting so probably a long walk and too much food. Garage tidying sounds noble, good luck with that.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'hiring', subject: 'Candidate feedback',
    turns: [
      'Did you get a chance to speak with the second candidate? I thought she was strong on the practical side, a bit less so on the strategy questions, but that is coachable. Curious whether you saw the same.',
      'Same impression. Practical answers were excellent, the strategy part felt rehearsed. I would still move her forward. Want to compare notes before the panel on Monday?',
      'Yes, let us do fifteen minutes Monday morning before it starts.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'vendor check-in', subject: 'Checking in on the timeline',
    turns: [
      'Just checking in on where things stand with the delivery. No pressure, I only want to make sure our internal dates still line up with yours.',
      'We are on track. One component slipped by a couple of days but it does not affect the overall date. I will confirm again at the end of next week.',
      'Great, thanks for the update.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'thanks', subject: 'Thank you',
    turns: [
      'Just wanted to say thanks for stepping in yesterday. It would have been a mess without you and I did not get a chance to say so properly at the time.',
      'Any time, honestly. You would have done the same. Let me know if the rest of it needs another pair of hands.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'process change', subject: 'Small change to how we hand things over',
    turns: [
      'Starting next sprint we are going to try handing over work with a short written note instead of the Friday call. The idea is fewer meetings, same information. Would love your honest take after the first one.',
      'Worth a try. My only concern is questions that used to get answered on the call now sitting until Monday. If the note has a clear owner to ask, that solves it.',
      'Good point, I will add an owner line at the top of the template.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'lunch', subject: 'Lunch this week?',
    turns: [
      'Are you around for lunch one day this week? There is a new place near the office that people keep mentioning and I have not tried it yet.',
      'Thursday works for me. I have heard the queue gets long so maybe a bit before noon?',
      'Thursday, just before noon. See you there.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'feedback request', subject: 'Your thoughts on the new layout',
    turns: [
      'We changed the layout of the weekly report based on the feedback from last quarter. Before I send it wider, could you glance at it and tell me if anything important got harder to find?',
      'Looked at it this morning. Much easier to scan. The only thing I would move is the risks section, it feels buried at the bottom now.',
      'Fair. I will move risks up under the summary. Thanks for looking.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'out of office', subject: 'Out next week',
    turns: [
      'Heads up that I am out all of next week. Nothing urgent should come up, but if it does, the team knows where things stand and can reach me for anything genuinely on fire.',
      'Noted, enjoy the time off. We will keep things ticking over and save the non-urgent questions for when you are back.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'podcast', subject: 'Episode worth a listen',
    turns: [
      'Listened to an episode on the drive in this morning that made me think of the conversation we had about planning. It is about forty minutes. I will pass on the name when I see you, it is not one I can spell.',
      'Ha, please do. My commute needs new material anyway, I have been through everything in my queue twice.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'contract renewal', subject: 'Renewal timing',
    turns: [
      'Our current agreement runs out at the end of the quarter. Before it gets close I wanted to ask whether you are expecting any changes on your side, so we can plan rather than scramble.',
      'No big changes expected. We might want to adjust the scope slightly based on this year, but the shape stays the same. Happy to talk it through in a couple of weeks.',
      'Sounds good, I will put something in the diary for early next month.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'moving', subject: 'New place',
    turns: [
      'We finally moved. Boxes everywhere, but the kitchen works and that is what matters. You should come by once we can find the chairs.',
      'Congratulations! Finding the chairs is the real milestone. Let me know when and I will bring something for the housewarming.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'training', subject: 'Training session next month',
    turns: [
      'We are putting together a short training session for the new tooling next month. Would you or someone on your team want a slot, or is everyone already comfortable with it?',
      'A couple of people would benefit. Two seats would be ideal. Morning sessions are easier for us if there is a choice.',
      'Two seats, morning. I will confirm the date once the room is booked.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'sports', subject: 'Did you watch',
    turns: [
      'Did you watch the match last night? I only caught the second half and it seemed like I missed all the interesting bits.',
      'You did, unfortunately. The first half had everything. I will spare you the play by play but it was worth staying up for.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'data request', subject: 'Numbers for the board deck',
    turns: [
      'For the board deck I need the same three figures as last time, ideally by Wednesday. If any of them are hard to pull this month just tell me and I will use an estimate with a note.',
      'All three are easy this month. I will send them Tuesday afternoon so you have a day of buffer.',
      'Perfect, thank you.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'apology', subject: 'Sorry about yesterday',
    turns: [
      'Sorry for dropping off the call so abruptly yesterday, my connection died and by the time it came back you had wrapped up. Did I miss any decisions I should know about?',
      'No worries, it happens. Only one decision: we are going with the shorter timeline. I will send the summary around this afternoon so you have it in writing.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'cooking', subject: 'That recipe',
    turns: [
      'Tried the recipe you sent. It worked, mostly. I think I over-reduced the sauce but nobody complained, so I am counting it as a success.',
      'Over-reduced sauce is still sauce. Next time take it off the heat a few minutes earlier than feels right. Glad it went down well.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'office logistics', subject: 'Desk moves on Friday',
    turns: [
      'A reminder that the desk moves happen Friday afternoon. If you have anything fragile on your desk it is worth taking it home Thursday. Facilities will label everything else.',
      'Thanks for the reminder. I will clear mine Thursday. Do we know where the printer is ending up?',
      'Same corner as now, it is the one thing not moving.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'travel', subject: 'Back from the trip',
    turns: [
      'Back from the trip and slowly catching up. It was great, a lot of walking, a lot of food, not enough sleep. How were things here while I was away?',
      'Quiet, mostly. One small drama with the schedule that sorted itself out. Welcome back, and I want to hear about the food.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'reference', subject: 'Reference request',
    turns: [
      'Someone I used to work with is applying for a role on your team and asked if I would put in a word. I will be honest rather than flattering, but the honest version is very positive. Let me know if it is useful.',
      'Very useful, thank you. If you could send a few lines on how they handled pressure, that is the part we cannot get from the interview.',
      'Good question. I will write that up tonight.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'confirmation', subject: 'Confirming the details',
    turns: [
      'Just confirming what we agreed: you will handle the first draft, I will review within two days, and we aim to have it final by the end of the month. Shout if I have any of that wrong.',
      'That is exactly right. Draft is already underway.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'weather', subject: 'This weather',
    turns: [
      'Is it as grey where you are as it is here? Three days of drizzle and I am starting to forget what the sun looks like.',
      'Worse, if anything. I have given up on the umbrella and accepted my fate. Spring cannot come soon enough.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'project kickoff', subject: 'Kickoff next week',
    turns: [
      'We are kicking off the new phase next week. I would like you in the room for the first hour if you can manage it, mostly so the team hears the context from you directly rather than second hand.',
      'I can do the first hour. Send me the invite and a one-paragraph brief and I will make sure I say the right things.',
      'Invite and brief coming your way this afternoon.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'expense', subject: 'Expense approval',
    turns: [
      'There is an expense sitting with you for approval from last month. Not urgent, but the deadline for the period is Friday so I wanted to flag it before it gets bounced.',
      'Approved just now, sorry it sat there. I had a filter hiding those notifications, which I have now fixed.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'music', subject: 'Playlist',
    turns: [
      'I added a few things to the shared playlist. Some of it is questionable, I admit, but at least two of them are genuinely good. You will know which two.',
      'I have my suspicions. Will report back after the gym tomorrow, which is the only place I actually listen to it.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'newsletter draft', subject: 'Internal update draft',
    turns: [
      'The internal update for this month is drafted. It is a little long. If you have five minutes, tell me which section you would cut and I will cut it.',
      'Cut the tooling section, it is already covered in the wiki. The rest reads well.',
      'Done. Thanks for the quick read.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'question', subject: 'Quick question',
    turns: [
      'Quick one: do you remember who owned the supplier list last year? I need to update a couple of contacts and I would rather not start from scratch.',
      'That was Priya, I think, before she moved teams. The file should still be in the shared folder under procurement.',
      'Found it, thanks.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'gardening', subject: 'Tomatoes',
    turns: [
      'The tomatoes finally did something. Three actual tomatoes after two months of leaves. I feel unreasonably proud.',
      'Three is a harvest. Proud is the right response. Mine are still leaves, so you are ahead.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'agenda', subject: 'Agenda for Monday',
    turns: [
      'Proposed agenda for Monday: a short review of last week, the two open decisions, and time at the end for anything people want to raise. Anything you want added?',
      'Add a five minute slot on the hiring timeline, otherwise that looks right.',
      'Added. See you Monday.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'birthday', subject: 'Happy birthday',
    turns: [
      'Happy birthday! I hope the day involves at least one thing that is not work. Let us celebrate properly when things calm down.',
      'Thank you! It involved cake, which counts. Definitely up for celebrating later.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'shared document', subject: 'Access to the shared folder',
    turns: [
      'Could you check whether I still have access to the shared folder? I am getting a permissions message and I am not sure if it is me or the folder.',
      'It was the folder, the permissions were reset during the reorganisation. You should be back in now, let me know if not.',
      'Back in, thank you.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'status', subject: 'Where we are',
    turns: [
      'Short status: two of the three pieces are done, the third is waiting on an external answer that should arrive this week. No action needed from you, just keeping you in the loop.',
      'Appreciated. Ping me if the external answer does not show up by Friday and I will chase it from my side.',
    ],
  },
  {
    language: 'en', register: 'casual', topic: 'film', subject: 'Film recommendation',
    turns: [
      'Watched something last night that I think you would like. Slow, quiet, beautifully shot. Not for everyone but very much for you, I suspect.',
      'You know my taste worryingly well. Adding it to the list for the weekend.',
    ],
  },
  {
    language: 'en', register: 'business', topic: 'policy', subject: 'Travel policy update',
    turns: [
      'The travel policy was updated last week, mostly small clarifications. The one that matters: bookings now go through the new portal rather than by email. Just so it does not catch you out.',
      'Thanks, that would have caught me out. Is there a link to the portal somewhere sensible?',
      'It is pinned in the general channel. I will resend it there so it is at the top.',
    ],
  },
  // ------------------------------------------------------------------ Dutch
  {
    language: 'nl', register: 'business', topic: 'vervolg gesprek', subject: 'Korte terugkoppeling van dinsdag',
    turns: [
      'Bedankt nog voor je tijd dinsdag. Ik heb mijn aantekeningen nagelopen en volgens mij staat het plan dat we schetsten nog steeds. Het enige dat ik zou toevoegen is een kort tussenmoment halverwege, zodat niemand aan het eind verrast is.',
      'Eens, een tussenmoment is verstandig. Wil jij de agenda daarvoor maken of zal ik? Maakt mij niet uit, als het maar in de agenda staat voordat het erbij inschiet.',
      'Ik pak het op. Ik stuur iets zodra ik de data heb.',
    ],
  },
  {
    language: 'nl', register: 'casual', topic: 'bijpraten', subject: 'Lang geleden',
    turns: [
      'Dat is lang geleden. Ik kwam je naam laatst tegen en bedacht dat we die koffie nooit hebben gedaan waar we het steeds over hadden. Hoe gaat het bij jou?',
      'Druk, maar op een goede manier. De nieuwe rol had even tijd nodig maar begint normaal te voelen. Koffie klinkt goed, volgende week ben ik er grotendeels.',
      'Volgende week werkt. Ik kijk morgen in mijn agenda en stel een paar momenten voor.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'factuur', subject: 'Vraag over vorige maand',
    turns: [
      'Kleine vraag over het laatste overzicht: een van de regels lijkt dubbel geteld. Kan aan mij liggen. Zou je het aan jouw kant kunnen checken voordat ik het bij finance neerleg?',
      'Je hebt gelijk, die stond er dubbel in. Al doorgegeven, een gecorrigeerde versie komt eraan. Excuus, en bedankt dat je het eruit haalde.',
      'Geen probleem, dat gebeurt. Fijn dat het zo snel is opgelost.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'afspraak verzetten', subject: 'Ons gesprek verzetten',
    turns: [
      'Er is iets tussen gekomen donderdagochtend en ik moet ons gesprek verzetten. Zou dezelfde tijd op vrijdag lukken, of anders begin volgende week?',
      'Vrijdag is prima. Zelfde tijd, zelfde link. Als er bij mij iets verandert laat ik het donderdagavond weten.',
      'Top, tot vrijdag.',
    ],
  },
  {
    language: 'nl', register: 'casual', topic: 'weekend', subject: 'Weekend',
    turns: [
      'Nog plannen voor het weekend? Wij denken erover de stad uit te gaan als het weer meezit, anders wordt het een saai weekend garage opruimen.',
      'Nog niets vast. Er komt een vriend langs dus waarschijnlijk een lange wandeling en te veel eten. Garage opruimen klinkt nobel, succes.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'feedback', subject: 'Je mening over de nieuwe opzet',
    turns: [
      'We hebben de opzet van het weekrapport aangepast op basis van de feedback van vorig kwartaal. Voordat ik het breder deel: zou je er even naar willen kijken en zeggen of iets belangrijks lastiger te vinden is geworden?',
      'Vanochtend bekeken. Veel makkelijker te scannen. Het enige dat ik zou verplaatsen is het risicodeel, dat zit nu wat verstopt onderaan.',
      'Terecht. Ik zet risico\'s onder de samenvatting. Bedankt voor het kijken.',
    ],
  },
  {
    language: 'nl', register: 'casual', topic: 'lunch', subject: 'Lunch deze week?',
    turns: [
      'Ben je deze week een dag beschikbaar voor lunch? Er is een nieuwe zaak bij kantoor waar iedereen het over heeft en ik ben er nog niet geweest.',
      'Donderdag kan bij mij. Ik hoor dat de rij lang wordt, dus misschien iets voor twaalven?',
      'Donderdag, net voor twaalf. Tot dan.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'status', subject: 'Waar we staan',
    turns: [
      'Korte status: twee van de drie onderdelen zijn klaar, het derde wacht op een extern antwoord dat deze week zou moeten komen. Geen actie nodig van jou, ik houd je alleen op de hoogte.',
      'Fijn. Geef een seintje als dat externe antwoord vrijdag nog niet binnen is, dan jaag ik het van mijn kant na.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'bedankje', subject: 'Bedankt',
    turns: [
      'Wilde je even bedanken voor het bijspringen gisteren. Zonder jou was het een rommeltje geworden en ik kwam er op het moment zelf niet aan toe dat goed te zeggen.',
      'Altijd, echt. Jij had hetzelfde gedaan. Laat weten als de rest ook nog een paar extra handen nodig heeft.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'agenda', subject: 'Agenda voor maandag',
    turns: [
      'Voorstel voor de agenda van maandag: korte terugblik op vorige week, de twee open besluiten, en aan het eind ruimte voor wat mensen willen inbrengen. Nog iets toevoegen?',
      'Voeg een blokje van vijf minuten toe over de wervingsplanning, verder ziet het er goed uit.',
      'Toegevoegd. Tot maandag.',
    ],
  },
  {
    language: 'nl', register: 'casual', topic: 'boek', subject: 'Dat boek',
    turns: [
      'Ik heb eindelijk het boek gekocht dat je aanraadde. Halverwege en het is veel beter dan ik verwachtte, vooral het middenstuk.',
      'Fijn dat het aanslaat. Het einde is wat abrupt, bij deze gewaarschuwd, maar de ideeën uit het midden bleven weken hangen. Laat weten wat je ervan vindt als je klaar bent.',
    ],
  },
  {
    language: 'nl', register: 'business', topic: 'toegang', subject: 'Toegang tot de gedeelde map',
    turns: [
      'Zou je kunnen kijken of ik nog toegang heb tot de gedeelde map? Ik krijg een rechtenmelding en weet niet of het aan mij of aan de map ligt.',
      'Het lag aan de map, de rechten waren gereset tijdens de reorganisatie. Je zou er nu weer in moeten kunnen, anders hoor ik het.',
      'Ik kan er weer in, dank je.',
    ],
  },
];

/** Generic continuation lines for a thread that outlives its script, and
 *  for replies to forwards. Short, low-content, the way real thread tails are. */
export const ACK_PHRASES: Record<string, string[]> = {
  en: [
    'Sounds good, thanks.',
    'Perfect, thank you.',
    'Great, thanks for letting me know.',
    'Got it, thanks.',
    'Thanks, that helps.',
    'Noted. Speak soon.',
    'Appreciate it.',
    'Thanks for the quick reply.',
    'Understood, thanks.',
    'Will do.',
  ],
  nl: [
    'Klinkt goed, dank je.',
    'Top, bedankt.',
    'Fijn, bedankt voor het laten weten.',
    'Duidelijk, dank.',
    'Bedankt, dat helpt.',
    'Genoteerd. Tot snel.',
    'Bedankt voor de snelle reactie.',
    'Begrepen, dank je.',
    'Doe ik.',
  ],
};

/** The note a forwarder writes above the forwarded message. */
export const FORWARD_NOTES: Record<string, string[]> = {
  en: [
    'Forwarding this in case it is relevant to what you are working on.',
    'FYI, see below. No action needed unless you disagree with any of it.',
    'Passing this along, thought you would want to see it.',
    'See below. Curious what you make of the last part.',
    'Thought this might be useful for you. Ignore if not.',
    'Sharing for visibility, the thread below has the context.',
  ],
  nl: [
    'Stuur ik even door voor het geval het relevant is voor waar je mee bezig bent.',
    'Ter info, zie hieronder. Geen actie nodig tenzij je het ergens niet mee eens bent.',
    'Even doorsturen, dacht dat je dit wel wilde zien.',
    'Zie hieronder. Benieuwd wat je van het laatste stuk vindt.',
    'Misschien handig voor jou. Negeren als het niet zo is.',
  ],
};

/** Replies to a forward. */
export const FORWARD_REPLIES: Record<string, string[]> = {
  en: [
    'Thanks for passing this along, useful context.',
    'Thanks, I had not seen this. Makes sense.',
    'Appreciate the heads up.',
    'Good to know, thanks for sharing.',
    'Thanks. I will keep it in mind for next week.',
  ],
  nl: [
    'Bedankt voor het doorsturen, nuttige context.',
    'Dank, dit had ik nog niet gezien. Logisch.',
    'Fijn dat je het doorgeeft.',
    'Goed om te weten, bedankt voor het delen.',
  ],
};

export const GREETINGS: Record<string, string[]> = {
  en: ['Hi {name},', 'Hey {name},', 'Hello {name},', '{name},', 'Hi {name}', 'Morning {name},', 'Hi,'],
  nl: ['Hoi {name},', 'Hi {name},', 'Hallo {name},', 'Beste {name},', 'Ha {name},', 'Hoi,'],
};

export const SIGN_OFFS: Record<string, string[]> = {
  en: ['Best,', 'Thanks,', 'Cheers,', 'Kind regards,', 'Talk soon,', 'Regards,', 'Best regards,', 'Thanks again,'],
  nl: ['Groet,', 'Groeten,', 'Met vriendelijke groet,', 'Dank,', 'Tot snel,', 'Hartelijke groet,'],
};

export function localized<T>(table: Record<string, T[]>, language: string): T[] {
  return table[language] ?? table.en ?? [];
}
