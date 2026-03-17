# Cold SMS Appointments — Collapsed (Tue Mar 10 2026, Global timezone)

Rule: person_key = (setter, phone or normalized name). Keep only the latest post per person_key; EOD status is the channel of that latest post.
Filter: Unconfirmed → include; Confirmed → include only if Calendar contains "cold sms" (case-insensitive).

## Confirmed (Cold SMS only)
| Time | Setter | Name | Phone | Permalink |
|------|--------|------|-------|-----------|
| 11:42:33 | Richard Ramilo |  | +15743120531 | <https://discord.com/channels/1164939432722440282/1332578941407334430/1480938920937132254> |
| 16:04:40 | Eddie Murillo |  | +13174800407 | <https://discord.com/channels/1164939432722440282/1332578941407334430/1481004884101697557> |
| 19:27:20 | Randy Nadera |  | +19378776189 | <https://discord.com/channels/1164939432722440282/1332578941407334430/1481055888079851611> |

## Unconfirmed (always Cold SMS; chronological)
| Time | Setter | Name | Phone | Permalink |
|------|--------|------|-------|-----------|
| 11:10:37 | Randy Nadera | James | +18122784045 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1480930886114349179> |
| 11:39:10 | Richard Ramilo | Amar | +12607152426 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1480938069489221786> |
| 11:54:49 | Daniel Franco | Sage | +19302159326 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1480942008041210029> |
| 15:43:36 | Richard Ramilo | Moses | +13179953049 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1480999584401457285> |
| 16:09:22 | Randy Nadera | Keith | +16024482899 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1481006069059682455> |
| 18:25:19 | Eddie Murillo | anthony | +13175239359 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1481040282743996437> |
| 19:00:52 | Randy Nadera | Paul | +17038501981 | <https://discord.com/channels/1164939432722440282/1387098677646196887/1481049229014339846> |

## Totals (Cold SMS only)
- Confirmed: 3
- Unconfirmed: 7
- Unique person_keys: 10