import test from "node:test";
import assert from "node:assert/strict";
import { describeCamera, chooseCamera, readChoices, rememberChoice, compareCameras, discoverCameras, setCameraMagnification } from "../public/auto-camera.js";
const device = (deviceId, label, zoom) => describeCamera({ deviceId, label }, { zoom });
const wide = device("wide", "背面広角カメラ");
const ultra = device("ultra", "Back Ultra Wide Camera");
const tele = device("tele", "背面望遠カメラ");
const virtual = device("triple", "背面トリプルカメラ", { min: 1, max: 10, step: 0.1 });

test("ズーム対応の仮想カメラを単体より優先する（日英の名称）", () => {
  for (const label of ["背面トリプルカメラ", "背面デュアル広角カメラ", "Back Triple Camera", "Back Dual Wide Camera"]) {
    const camera = device("virtual", label, { min: 1, max: 10 });
    assert.equal(chooseCamera([wide, ultra, tele, camera], 5).selected, camera);
  }
});
test("仮想カメラがない・ズーム非対応の場合、実現できる倍率が最も近い単体を使う", () => {
  const noZoom = device("virtual", "背面トリプルカメラ");
  for (const cameras of [[wide, ultra], [noZoom, wide, ultra]]) {
    assert.equal(chooseCamera(cameras, 0.5).selected, ultra);
    assert.equal(chooseCamera(cameras, 1).selected, wide);
  }
  const zoomWide = device("wide-zoom", "Back Wide Camera", { min: 1, max: 4 });
  assert.equal(chooseCamera([ultra, zoomWide], 3).selected, zoomWide);
});
test("倍率が不明な望遠・名前不明・同等の候補は撮り比べを求める", () => {
  for (const cameras of [[wide, tele], [wide, device("unknown", "")]]) {
    const decision = chooseCamera(cameras, 3);
    assert.equal(decision.selected, null);
    assert.equal(decision.candidates.length, 2);
  }
});
test("撮り比べの選択を記憶し、再起動時に同じ候補と倍率で復元する", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const decision = chooseCamera([wide, tele], 3);
  assert.equal(rememberChoice(storage, decision.key, tele.deviceId), true);
  assert.equal(chooseCamera([tele, wide], 3, readChoices(storage)).selected, tele);
  assert.equal(chooseCamera([wide, tele], 1, readChoices(storage)).selected, null);
  assert.equal(chooseCamera([wide], 3, readChoices(storage)).selected, wide);
  assert.deepEqual(readChoices({ getItem: () => "{" }), {});
  assert.equal(rememberChoice(undefined, decision.key, "tele"), false);
});
test("各候補を1枚ずつ撮り、ストリームを止めてから並べて選択を求める", async () => {
  const events = [];
  const result = await compareCameras([wide, tele], {
    open: async (camera) => { events.push(`open:${camera.deviceId}`); return { stream: { getTracks: () => [{ stop: () => events.push(`stop:${camera.deviceId}`) }] } }; },
    capture: async (_, camera) => { events.push(`capture:${camera.deviceId}`); return `frame:${camera.deviceId}`; },
    choose: async (samples) => { events.push("choose"); assert.deepEqual(samples.map((sample) => sample.image), ["frame:wide", "frame:tele"]); return samples[1].camera; },
  });
  assert.equal(result, tele);
  assert.deepEqual(events, ["open:wide", "capture:wide", "stop:wide", "open:tele", "capture:tele", "stop:tele", "choose"]);
});
test("撮り比べの失敗・中断・選択取消でもストリームを解放し、結果を採用しない", async () => {
  for (const mode of ["capture", "hidden", "cancel"]) {
    let stopped = 0;
    let active = true;
    await assert.rejects(compareCameras([wide], {
      active: () => active,
      open: async () => ({ stream: { getTracks: () => [{ stop: () => stopped++ }] } }),
      capture: async () => { if (mode === "capture") throw new Error("失敗"); if (mode === "hidden") active = false; return "frame"; },
      choose: async () => null,
    }));
    assert.equal(stopped, 1);
  }
});
test("単体の基準倍率に応じてズームを適用し、最大範囲へ収める", async () => {
  let constraints;
  const track = { applyConstraints: async (value) => { constraints = value; }, getSettings: () => ({ zoom: 2 }) };
  const camera = device("ultra", "背面超広角カメラ", { min: 1, max: 4, step: 1 });
  assert.deepEqual(await setCameraMagnification(track, camera, 1), { requested: 1, actual: 1 });
  assert.equal(constraints.advanced[0].zoom, 2);
  assert.deepEqual(await setCameraMagnification(track, virtual, 20), { requested: 10, actual: 2 });
  assert.deepEqual(await setCameraMagnification(track, tele, 3), { requested: 3, actual: null });
});
test("許可後に背面候補の能力を順番に調べ、前面を除外し最大解像度を要求する", async () => {
  let running = 0;
  const requests = [];
  const media = {
    enumerateDevices: async () => [wide, virtual, { deviceId: "front", label: "Front Camera" }].map((item) => ({ ...item, kind: "videoinput" })),
    getUserMedia: async ({ video }) => {
      assert.equal(running, 0); running++;
      const id = video.deviceId?.exact ?? "wide";
      const camera = id === "triple" ? virtual : wide;
      const track = { label: camera.label, getSettings: () => ({ deviceId: id, facingMode: "environment" }),
        getCapabilities: () => ({ zoom: camera.range, width: { max: 4032 }, height: { max: 3024 } }),
        applyConstraints: async (value) => requests.push(value), stop: () => running-- };
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    },
  };
  const candidates = await discoverCameras(media);
  assert.equal(running, 0);
  assert.deepEqual(candidates.map((camera) => camera.deviceId), ["wide", "triple"]);
  assert.equal(chooseCamera(candidates, 3).selected.deviceId, "triple");
  assert.ok(requests.every((value) => value.width.ideal === 4032 && value.height.ideal === 3024));
});

test("能力不明の望遠ではハードウェアズーム値を光学倍率と断定しない", async () => {
  const camera = device("tele", "背面望遠カメラ", { min: 1, max: 8, step: 1 });
  const track = { applyConstraints: async () => {}, getSettings: () => ({ zoom: 3 }) };
  assert.deepEqual(await setCameraMagnification(track, camera, 3), { requested: 3, actual: null });
});

test("列挙が使えなくても現在の背面カメラを調べ、裏へ移った場合は解放する", async () => {
  for (const abort of [false, true]) {
    let running = 0;
    let active = true;
    const media = {
      enumerateDevices: async () => { if (abort) active = false; throw new Error("非対応"); },
      getUserMedia: async () => {
        running++;
        const track = { label: "背面広角カメラ", getSettings: () => ({ facingMode: "environment", deviceId: "wide" }), stop: () => running-- };
        return { getVideoTracks: () => [track], getTracks: () => [track] };
      },
    };
    if (abort) await assert.rejects(discoverCameras(media, () => active), /中断/);
    else assert.equal((await discoverCameras(media))[0].deviceId, "wide");
    assert.equal(running, 0);
  }
});

test("複数のズーム対応仮想カメラでも撮り比べず、広い範囲を選ぶ", () => {
   const dual = device("dual", "背面デュアル広角カメラ", { min: 1, max: 8 });
   const decision = chooseCamera([wide, tele, dual, virtual], 3);
   assert.equal(decision.selected, virtual);
   assert.match(decision.reason, /仮想カメラ/);
 });
