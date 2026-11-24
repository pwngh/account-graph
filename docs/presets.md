# Presets

A preset is a policy setting for a common situation. Hand one to the server and it lays it over the default.

```sh
POLICY_FILE=examples/household.json npm start
```

Switching to one, or away from one, calls for a rebuild. [The policy](operations.md#the-policy) says how.

## Contacts entered by staff

The default suits people who contact you themselves: whoever calls from a number is usually the person who has it. It does not suit a list that staff type in, where a parent, a child and a former spouse are all on file under one phone.

`examples/household.json` is for that list:

```json
{
  "kinds": {
    "phone": { "weight": 0.85, "dilution": 1, "cap": 10, "halfLife": 63072000000, "group": "household" },
    "voip": { "group": "household" },
    "address": { "group": "household" },
    "ip": { "group": "household" }
  }
}
```

A phone alone no longer joins two people. And a phone, an address and an internet connection count once between them, because a household shares all three.

| Two subjects share | By default | With the preset |
| --- | --- | --- |
| A phone | 0.90, joined | 0.85, related |
| A phone and a confirmed address | 0.96, joined | 0.85, related |
| A phone and an email | joined | joined |
| An IP and a confirmed address | 0.72, related | 0.60, related |

A number changes hands, so under the preset the phone also fades: its evidence halves for each two years between the two sightings.

These weights are priors. They were chosen for the situation above, not fitted to your traffic; [`fit`](library.md) sets them from pairs your reviewers have decided.

### What the preset costs

Someone who calls becomes a `caller:` subject with their number. Under the preset, the contact on file with that number is only related to the caller, so a later step of the contact would not be credited to the caller's ad click.

Close that gap where the fact is known. When staff take a call and open the contact it is about, have your backend say so:

```sh
curl -X POST https://graph.example.org/join -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"source":"desk","pairs":[{"a":"caller:96f2c503…","b":"contact:7","reason":"answered by staff"}]}'
```

The `caller:` subject is in the answer to `POST /call`.

### Shared phones, without deleting them

Where a system treats a shared phone as an error, staff learn to switch the number off on everyone but one. The graph needs the opposite: it keeps the number on each person, and you say what is known about the two.

| What you know | What to do |
| --- | --- |
| They are one person | `join` the two. |
| They are two people, and nothing hangs on it | Leave them related. |
| They are two people and must never be taken for one | `separate` them. |
| The number belongs to nobody in particular: a front desk, a shelter, a school | `ignore` that number. |

There is no need to remove a phone from anyone. Removing it loses the tie to every call it made.

## A preset of your own

Write one the same way, and start the server with it. `policyProblems` in `account-graph` checks a policy without starting anything. A group is any name you choose: kinds that carry the same name count once between them.
