# CUBE Configuration (WFC-VG1)

Add these blocks to the existing CUBE config alongside tenant 100 (Webex Calling) and tenant 200 (ElevenLabs).

## URI for FreeSWITCH
voice class uri freeswitch sip
 host ipv4:34.41.17.98

## SIP Profile 400 - rewrite SDP for FreeSWITCH
voice class sip-profiles 400
 rule 10 request ANY sdp-header Connection-Info modify "IN IP4 10.0.0.4" "IN IP4 40.160.129.46"
 ...

## Tenant 300 - FreeSWITCH peer
voice class tenant 300
 no remote-party-id
 sip-server ipv4:34.41.17.98
 session transport udp

## Dial-peers
dial-peer voice 1122 voip
 description To FreeSWITCH IVR
 destination-pattern 1122
 ...

dial-peer voice 1123 voip
 description From FreeSWITCH IVR return
 ...
