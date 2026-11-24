# Presets

A preset is a policy for a common situation. Set `POLICY_FILE` and the server applies it over the default.

```sh
POLICY_FILE=examples/household.json npm start
```

Rebuild after switching to or from a preset. See [the policy](operations.md#policy).

## Contacts entered by staff

Use `examples/household.json` for a list that staff type in, where a parent, a child and a former spouse share one phone on file. The default policy suits people who contact you themselves, where the caller usually owns the number.

```json
{
  "kinds": {
    "phone": { "weight": 0.85, "dilution": 1, "cap": 10, "halfLife": 63072000000, "group": "household" },
    "voip": { "group": "household" },
    "address": { "group": "household" },
    "ip": { "group": "household" },
    "name": { "weight": 0.6, "dilution": 1, "cap": 5, "halfLife": "none", "group": "name", "corroborates": true }
  }
}
```

Under the preset, a phone alone relates two people without joining them. A phone, an address and an internet connection count once between them, because a household shares all three.

| Two subjects share | Default | Preset |
| --- | --- | --- |
| A phone | 0.90, joined | 0.85, related |
| A phone and a confirmed address | 0.96, joined | 0.85, related |
| A phone and an email | joined | joined |
| An IP and a confirmed address | 0.72, related | 0.60, related |
| A phone and a name | 0.90, joined | 0.94, joined |
| A name | kind absent | no link |

A name confirms a link that a phone, email or address already made. The two must be related without it, and share a first and last name with the same zip code or date of birth. See [Names](identify.md#names).

> **Names repeat in families.** A father and son, or mother and daughter, with one name at one address are joined once they also share a phone. `separate` them when you know they are two people.

Phone evidence halves for each two years between the two sightings, because numbers change hands.

### Caller attribution

A caller becomes a `caller:` subject with their number. Under the preset, the contact on file with that number is only related to the caller. A later step of the contact is then not credited to the caller's ad click.

To close the gap, have your backend join the two when staff open the contact a call is about. Leave out a call by somebody who speaks for another, such as a parent about a child: that is another person, and joining the two mixes their records.

```sh
curl -X POST https://graph.example.org/join -H "authorization: Bearer $GRAPH_TOKEN" \
  -d '{"source":"desk","pairs":[{"a":"caller:96f2c503…","b":"contact:7","reason":"answered by staff"}]}'
```

The `caller:` subject is in the answer to `POST /call`.

### Shared phones

Keep a shared phone on each person, and record what you know about the two. Removing the number also removes the link to every call it made.

| What you know | Action |
| --- | --- |
| They are one person | `join` the two. |
| They are two people, and the distinction has no consequence | Leave them related. |
| They are two people and must stay distinct | `separate` them. |
| The number belongs to a front desk, a shelter or a school | `ignore` that number. |

## Custom presets

Write a policy the same way and start the server with it. `policyProblems` in `account-graph` checks a policy without starting a server. A group is any name you choose, and kinds with the same group count once between them.

## Limitations

- **Weights.** The preset's weights are priors chosen for the situation. [`fit`](library.md#fitting-the-weights) sets them from pairs your reviewers have decided.
