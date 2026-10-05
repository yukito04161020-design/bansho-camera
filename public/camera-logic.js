// 解像度は必須値にせずidealで要求し、低解像度の端末でも検証できるようにします。
export function resolutionConstraints(capabilities = {}, deviceId = "") {
  const maximum = (range, fallback) => Number.isFinite(range?.max) && range.max > 0
    ? range.max : fallback;
  return {
    facingMode: { exact: "environment" },
    width: { ideal: maximum(capabilities.width, 7680) },
    height: { ideal: maximum(capabilities.height, 4320) },
    resizeMode: { ideal: "none" },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export async function openRearCamera(mediaDevices, { deviceId = "" } = {}) {
  let stream = await mediaDevices.getUserMedia({
    audio: false,
    video: resolutionConstraints({}, deviceId),
  });
  let track = stream.getVideoTracks()[0];
  try {
    if (!track) throw new Error("映像トラックがありません。");
    // 背面指定を無視するブラウザで、前面を背面と誤認して検証しないようにします。
    const facingMode = track.getSettings?.().facingMode;
    if (facingMode && facingMode !== "environment") {
      throw new Error("背面カメラを取得できませんでした。");
    }
    let requested = resolutionConstraints({}, deviceId);
    let adjusted = false;
    if (typeof track.getCapabilities === "function" && typeof track.applyConstraints === "function") {
      try {
        requested = resolutionConstraints(track.getCapabilities(), deviceId);
        await track.applyConstraints(requested);
        adjusted = true;
      } catch {
        // 能力値の取得・再要求が使えなくても、最初に取得した映像で検証を続けます。
        requested = resolutionConstraints({}, deviceId);
      }
    }
    // 高解像度要求でズーム能力が消えるSafariでは、制約の少ない同じカメラを試す。
    const capabilities = () => { try { return track.getCapabilities?.() || {}; } catch { return {}; } };
    const hasZoom = (value) => value.zoom?.max > value.zoom?.min && value.zoom.min > 0;
    if (deviceId && !hasZoom(capabilities())) {
      stream.getTracks().forEach((item) => item.stop());
      stream = await mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId }, facingMode: { exact: "environment" } } });
      track = stream.getVideoTracks()[0];
      if (!track || (track.getSettings?.().facingMode && track.getSettings().facingMode !== "environment")) throw new Error("背面カメラを取得できませんでした。");
      const available = capabilities();
      requested = { deviceId: { exact: deviceId }, facingMode: { exact: "environment" } };
      adjusted = false;
      if (track.applyConstraints && available.width?.max && available.height?.max) {
        const maximum = { ...requested, width: { ideal: available.width.max }, height: { ideal: available.height.max } };
        try {
          await track.applyConstraints(maximum);
          if (hasZoom(available) && !hasZoom(capabilities())) await track.applyConstraints(requested);
          else { requested = maximum; adjusted = true; }
        } catch { await track.applyConstraints(requested); }
      }
    }
    return { stream, requested, adjusted };
  } catch (error) {
    stream.getTracks().forEach((item) => item.stop());
    throw error;
  }
}

export function captureFrame(video, canvas) {
  const { videoWidth: width, videoHeight: height } = video;
  if (video.readyState < 2 || width <= 0 || height <= 0) {
    throw new Error("映像の準備ができていません。少し待ってから撮影してください。");
  }
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像を表示できません。このページを開き直してください。");
  canvas.width = width;
  canvas.height = height;
  context.drawImage(video, 0, 0, width, height);
  return { width, height };
}
