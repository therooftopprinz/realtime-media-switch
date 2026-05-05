server.py will:
- serve webapp.html at / (fixed)
- http websocket reverse proxy to local transport switch instance (converts websocket/rtms to udp/rtms)
    served at /ws (fixed)

./server.py --help
--connect local_switch_host:local_switch_port
--listen local_server_host:local_server_port

webapp.html
- inspired from ~/development/RoIP-Server/webapp/ws.html

supported meta:
* chat
```meta
Name: Chat
Content-Type: text/plain
```
* audio
```meta
Name: Opus Audio
Content-Type: audio/opus; rate=48000
```
* video
```meta
Name: H264 Video
Content-Type: video/H264
```

WebApp UI:
<username> <password> <connect>
<workspace>

</workspace>
<add><channels_bar>

Add (popup): (create or join channel)
name <in/>
meta <dropdown/>
source <dropdown/>

supported sources:
- text
- mic
- camera
- screen capture

added channels will appear on channel bar
clicking channel will switch to channel workspace

workspace display (by meta):
* text
- use for chatting
- show scrollable chat history
- bottom is the input are like most messenger apps
- shows time stamp and user name and message
* audio
- shows active speaking users
- shows inactive users
* video
- shows active video
- can click on one to maximize