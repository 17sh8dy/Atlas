# Verified answers (draft, for review)

Each entry below becomes a reviewed answer Atlas can give without a language model, internet or account.
**Nothing here ships until you change its `review:` to `approved`.** Read every answer against its source.

How it works: if a question contains all the meaningful words of one of an entry's `match` phrases, that entry's
answer is given, with a "Source" line and "Verified answer". An answer can use `{placeholders}` that Atlas fills
from live state (`{atlasVersion}`, `{packDate}`, `{autoRefresh}`, `{liveLookups}`, `{capabilityCount}`); if one
cannot be filled, the entry does not answer. `since` is the first Atlas version that has what the answer says.

## atlas.tokens.how-counted
title: How Atlas counts tokens
topic: tokens
aspects: how, what
match: count tokens | token counting | token usage | how many tokens | estimate tokens | counts tokens
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Atlas/blob/main/docs/TOKEN-ACCOUNTING.md
answer:
Atlas uses the number your model or provider reports whenever there is one. Only when nothing is reported does it estimate, and an estimate is always labelled as one. The estimate looks at the text: it weights characters by script, treats code, JSON and logs as costing more than prose, and learns a correction for each model from the counts that model reports.

## atlas.tokens.limit
title: Monthly limits and tokens
topic: tokens
aspects: how, what
match: monthly limit | token limit | usage cap | spending limit | limit reached | cap tokens
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Atlas/blob/main/docs/TOKEN-ACCOUNTING.md
answer:
A monthly limit you set for a provider counts confirmed tokens, estimated tokens, and the input of requests that may have reached the provider before failing, because a limit protects money and those requests may have cost some. That means a limit can trigger slightly earlier than your provider's bill would suggest, never later.

## atlas.tokens.uncertain
title: Tokens that may have been billed
topic: tokens
aspects: what, why
match: may have been billed | uncertain tokens | failed request tokens
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Atlas/blob/main/docs/TOKEN-ACCOUNTING.md
answer:
These are requests that may have reached your provider and then failed or been cut off, so they may have been billed. They count toward your monthly limit but not toward your lifetime total. A request that never left your computer, such as one with no connection, costs nothing and is not counted.

## atlas.knowledge.where-from
title: Where Atlas's knowledge about Nova comes from
topic: knowledge
aspects: what, where, how
match: where knowledge | knowledge come from | what do you know about nova | how do you know | your documentation | knowledge pack
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Nova-Knowledge/blob/main/README.md
answer:
Atlas carries a signed copy of reference pages about Nova and its products, so it can answer without a language model, an internet connection or an account. Its pack is dated {packDate}. Refreshing that copy from the Nova Knowledge repository is {autoRefresh}, and looking up current information from Nova's public pages is {liveLookups}. Both can be changed in Settings.

## atlas.knowledge.offline
title: Does Atlas need the internet to answer questions about Nova?
topic: knowledge
aspects: can
match: need internet | work offline | without internet | offline questions
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Nova-Knowledge/blob/main/README.md
answer:
No. Questions about Nova and Atlas are answered from the signed copy that ships with Atlas, so they work offline and without an account. Only questions about something that changes, such as what is new in a release, use the internet, and then only to read Nova's public pages.

## nova.accounts.required
title: Does Nova require an account?
topic: accounts
aspects: can
match: require account | need account | account required | have to sign in | nova account required
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Nova-Knowledge/blob/main/pages/accounts.md
answer:
No. A Nova Account is optional. Atlas, Replay.GG and Nova Cut do not require one, and what already worked without an account keeps working without one. An account only adds things on top. For how personal data is handled, read the Nova Privacy Policy and the product documents on Nova Legal.

## atlas.model.required
title: Does Atlas need an AI model?
topic: models
aspects: can
match: need model | need ai | language model required | work without model | without ai
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Atlas/blob/main/README.md
answer:
No. Atlas can carry out the actions it knows without a language model, and it answers questions about Nova from its built-in knowledge. A model is optional: connecting one lets Atlas hold a fuller conversation and handle requests its built-in rules do not cover.

## atlas.updates.how
title: How Atlas updates
topic: updates
aspects: how
match: how update | update atlas | atlas updates | check for updates
since: 2.0.3
review: draft
sources: https://github.com/17sh8dy/Atlas/blob/main/docs/SECURITY-HARDENING-2.0.md
answer:
Atlas checks GitHub's release hosting for newer versions of itself. An update must carry a digital signature from Atlas's release key and match the installer's checksum, and Atlas only looks for updates in its own project's releases. An update that does not verify is not installed. You are on version {atlasVersion}.
