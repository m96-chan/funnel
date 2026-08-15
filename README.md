# Funnel

Turn your spare Android phones into on-demand **remote cameras** and **remote microphones**, managed from a single dashboard.

If you have a drawer full of old Android devices, Funnel lets each one become a network-accessible camera/mic feed. Register the phones you want to use in the dashboard, stream from the ones you need, and unregister them when you are done.

## Use case

I have many Android phones. I want to use them as remote cameras and remote microphones.

Instead of dedicated IP cameras or USB webcams, each Android device runs the Funnel app, announces itself to a dashboard, and can be selected on demand as a live audio/video source — for a meeting, a stream, home monitoring, a multi-angle recording setup, or anything that needs an extra camera/mic.

## How it works

```
 ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
 │  Android #1 │        │  Android #2 │        │  Android #N │
 │  Funnel app │  ...   │  Funnel app │  ...   │  Funnel app │
 └──────┬──────┘        └──────┬──────┘        └──────┬──────┘
        │  register / stream   │                      │
        └──────────────┬───────┴──────────────────────┘
                       │
                ┌──────▼───────┐
                │  Dashboard   │   ← discover, register, select, stream
                │   / Server   │
                └──────┬───────┘
                       │
                ┌──────▼───────┐
                │  Your client │   (browser, meeting app, OBS, etc.)
                └──────────────┘
```

- Each phone runs the **Funnel Android app** and registers itself with the dashboard.
- The **dashboard** lists every registered phone and its status (online, streaming, battery, etc.).
- You **select** a phone and consume its camera and microphone as a remote source.
- When you are finished, you **unregister** the phone to free it up.

## How to use

1. **Install** the Funnel Android APK on each phone.
2. **Start** the app.
3. **Register** the device in the dashboard. You can register many phones.
4. **Select** a phone and use it as a remote camera / microphone.
5. When you are finished, **unregister** it.

## Components

| Component        | Role                                                              |
| ---------------- | ---------------------------------------------------------------- |
| Android app      | Captures camera + mic, registers with the dashboard, streams.     |
| Dashboard/Server | Registry of devices, selection UI, and stream broker.             |
| Client           | Consumes the selected phone's feed (browser / virtual cam / app). |

## Status

🚧 Early stage — this repository currently defines the concept and roadmap. Implementation is in progress.

## License

[MIT](./LICENSE) © 2026 Yusuke Harada
