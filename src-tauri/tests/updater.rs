#![cfg(target_os = "macos")]

use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::Command,
    time::Duration,
};
use tauri_plugin_updater::UpdaterExt;

fn succeeds(command: &mut Command) {
    // CLI signer output can contain test key material. Never print it.
    assert!(command
        .output()
        .expect("run fixture command")
        .status
        .success());
}

#[test]
fn real_plugin_checks_verifies_installs_in_isolation_and_rejects_tampering() {
    let root = tempfile::tempdir().unwrap();
    let cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.bin/tauri");
    let key = root.path().join("test.key");
    succeeds(
        Command::new(&cli)
            .args(["signer", "generate", "--ci", "--write-keys"])
            .arg(&key),
    );
    let source = root.path().join("source");
    let contents = "Sample.app/Contents/MacOS/sample";
    let original = root.path().join("installed").join(contents);
    let replacement = source.join(contents);
    fs::create_dir_all(original.parent().unwrap()).unwrap();
    fs::create_dir_all(replacement.parent().unwrap()).unwrap();
    fs::write(&original, "old").unwrap();
    fs::write(&replacement, "new").unwrap();
    let archive = root.path().join("Sample.app.tar.gz");
    succeeds(
        Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg("Sample.app")
            .env("COPYFILE_DISABLE", "1"),
    );
    succeeds(
        Command::new(&cli)
            .args(["signer", "sign", "--private-key-path"])
            .arg(&key)
            .arg(&archive)
            .env("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", ""),
    );
    let signature = fs::read_to_string(archive.with_extension("gz.sig")).unwrap();
    let public = fs::read_to_string(key.with_extension("key.pub")).unwrap();
    let bytes = fs::read(&archive).unwrap();
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let metadata = serde_json::to_vec(&serde_json::json!({
        "version": "0.2.0", "url": format!("http://{address}/app"), "signature": signature.trim(),
    }))
    .unwrap();
    let serving = std::thread::spawn(move || {
        for n in 0..5 {
            let (mut stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() <= 4096);
            }
            let mut payload = match n {
                0 => vec![],
                1 | 3 => metadata.clone(),
                _ => bytes.clone(),
            };
            if n == 4 {
                payload[0] ^= 1;
            }
            write!(stream, "HTTP/1.1 {}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", if n == 0 { "204 No Content" } else { "200 OK" }, payload.len()).unwrap();
            stream.write_all(&payload).unwrap();
        }
    });
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": public.trim(), "dangerousInsecureTransportProtocol": true,
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        .executable_path(&original)
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .endpoints(vec![format!("http://{address}/check").parse().unwrap()])
        .unwrap()
        .build()
        .unwrap();
    tauri::async_runtime::block_on(async {
        assert!(updater.check().await.unwrap().is_none());
        let update = updater.check().await.unwrap().unwrap();
        let verified = update.download(|_, _| {}, || {}).await.unwrap();
        assert_eq!(fs::read_to_string(&original).unwrap(), "old");
        update.install(&verified).unwrap();
        assert_eq!(fs::read_to_string(&original).unwrap(), "new");
        let update = updater.check().await.unwrap().unwrap();
        assert!(update.download(|_, _| {}, || {}).await.is_err());
        assert_eq!(fs::read_to_string(&original).unwrap(), "new");
    });
    serving.join().unwrap();
}
