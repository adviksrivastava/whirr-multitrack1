
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Interface elements
const tracksContainer = document.getElementById("tracksContainer");
const addTrackBtn = document.getElementById("addTrackBtn");
const inputDevice = document.getElementById("inputDevice");

const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const recordBtn = document.getElementById("recordBtn");

const timeDisplay =
    document.getElementById("timeDisplay") ||
    document.getElementById("timerDisplay") ||
    document.querySelector(".time-display");

const metronomeEnabled = document.getElementById("metronomeEnabled");
const bpmInput = document.getElementById("bpmInput");
const measureCountInput = document.getElementById("measureCount");

// Application state
let selectedTrack = null;
let recordingTrack = null;
let activeRecorder = null;
let recordingChunks = [];
let recordingStream = null;

let isRecording = false;
let isCountingIn = false;
let isPlaying = false;

let countdownToken = 0;
let recordingLimitTimeout = null;
let metronomeScheduler = null;
let nextClickTime = 0;

let playbackSources = [];
let playbackGains = [];
let playbackEndTimeout = null;

let elapsedSeconds = 0;
let timerInterval = null;

let playheadInterval = null;
let playheadStartedAt = 0;
let playheadDurationMs = 0;

let nextTrackNumber = 1;

const trackColors = [
    "#d6a65b",
    "#82a58a",
    "#c77c65",
    "#8e9ac2",
    "#c7ad76",
    "#a58bb8"
];


// --------------------------------------------------
// TIMER
// --------------------------------------------------

function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${String(minutes).padStart(2, "0")}:${String(
        remainingSeconds
    ).padStart(2, "0")}`;
}

function updateTimerDisplay(value = formatTime(elapsedSeconds)) {
    if (timeDisplay) {
        timeDisplay.textContent = value;
    }
}

function startClock() {
    stopClock();

    timerInterval = setInterval(() => {
        if (isRecording || isPlaying) {
            elapsedSeconds++;
            updateTimerDisplay();
        }
    }, 1000);
}

function stopClock() {
    if (timerInterval !== null) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}


// --------------------------------------------------
// MEASURE SETTINGS
// --------------------------------------------------

function getMeasureCount() {
    const count = Number(measureCountInput?.value) || 4;
    return Math.max(1, Math.min(64, Math.floor(count)));
}

function getBpm() {
    const bpm = Number(bpmInput?.value) || 100;
    return Math.max(40, Math.min(240, bpm));
}

function getProjectDuration() {
    return getMeasureCount() * 4 * (60 / getBpm());
}


// --------------------------------------------------
// TIMELINE GRID AND PLAYHEAD
// --------------------------------------------------

function updateMeasureGrid() {
    const count = getMeasureCount();

    document.querySelectorAll(".track-lane").forEach(lane => {
        let ruler = lane.querySelector(".measure-ruler");

        if (!ruler) {
            ruler = document.createElement("div");
            ruler.className = "measure-ruler";
            lane.prepend(ruler);
        }

        ruler.innerHTML = "";
        ruler.style.gridTemplateColumns =
            `repeat(${count}, minmax(0, 1fr))`;

        for (let measure = 1; measure <= count; measure++) {
            const label = document.createElement("span");
            label.textContent = measure;
            ruler.appendChild(label);
        }

        const beatWidth = 100 / (count * 4);
        const measureWidth = 100 / count;

        lane.style.backgroundImage = `
            repeating-linear-gradient(
                to right,
                transparent 0,
                transparent calc(${beatWidth}% - 1px),
                #a99a7655 calc(${beatWidth}% - 1px),
                #a99a7655 ${beatWidth}%
            ),
            repeating-linear-gradient(
                to right,
                transparent 0,
                transparent calc(${measureWidth}% - 2px),
                #d6a65b99 calc(${measureWidth}% - 2px),
                #d6a65b99 ${measureWidth}%
            )
        `;
    });

    updatePlayheadElements();
}

function updatePlayheadElements() {
    document.querySelectorAll(".track-lane").forEach(lane => {
        if (!lane.querySelector(".timeline-playhead")) {
            const playhead = document.createElement("div");
            playhead.className = "timeline-playhead";
            lane.appendChild(playhead);
        }
    });
}

function updatePlayhead() {
    if (!playheadDurationMs) return;

    const elapsed = performance.now() - playheadStartedAt;
    const progress = Math.min(
        100,
        (elapsed / playheadDurationMs) * 100
    );

    document.querySelectorAll(".timeline-playhead").forEach(line => {
        line.style.left = `${progress}%`;
    });
}

function startPlayhead(durationSeconds) {
    stopPlayhead(false);

    playheadStartedAt = performance.now();
    playheadDurationMs = durationSeconds * 1000;

    updatePlayhead();

    playheadInterval = setInterval(() => {
        updatePlayhead();

        if (
            performance.now() - playheadStartedAt >=
            playheadDurationMs
        ) {
            updatePlayhead();
            clearInterval(playheadInterval);
            playheadInterval = null;
        }
    }, 30);
}

function stopPlayhead(reset = true) {
    if (playheadInterval !== null) {
        clearInterval(playheadInterval);
        playheadInterval = null;
    }

    if (reset) {
        playheadDurationMs = 0;

        document.querySelectorAll(".timeline-playhead").forEach(line => {
            line.style.left = "0%";
        });
    }
}

measureCountInput?.addEventListener("change", () => {
    measureCountInput.value = getMeasureCount();
    updateMeasureGrid();
});


// --------------------------------------------------
// TRACK CREATION
// --------------------------------------------------

function addTrack(name = `TRACK ${nextTrackNumber}`) {
    if (isRecording || isCountingIn) {
        alert("Stop recording before adding a track.");
        return;
    }

    const track = document.createElement("div");
    track.className = "track";

    const color =
        trackColors[(nextTrackNumber - 1) % trackColors.length];

    track.dataset.color = color;
    track.dataset.muted = "false";
    track.dataset.solo = "false";
    track.dataset.volume = "0.8";

    track.innerHTML = `
        <div class="track-controls">
            <input
                class="track-name"
                type="text"
                value="${name}"
                aria-label="Track name"
            >

            <div class="control-row">
                <button
                    class="track-btn arm-btn"
                    title="Select recording track"
                    type="button"
                >ARM</button>

                <button
                    class="track-btn mute-btn"
                    title="Mute"
                    type="button"
                >M</button>

                <button
                    class="track-btn solo-btn"
                    title="Solo"
                    type="button"
                >S</button>

                <input
                    class="track-volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value="0.8"
                    aria-label="Track volume"
                >

                <button
                    class="track-btn delete-btn"
                    title="Delete track"
                    type="button"
                >×</button>
            </div>
        </div>

        <div class="track-lane">
            <div class="empty-track">
                <span>NO AUDIO RECORDED</span>
            </div>
        </div>
    `;

    tracksContainer.appendChild(track);
    nextTrackNumber++;

    const armButton = track.querySelector(".arm-btn");
    const muteButton = track.querySelector(".mute-btn");
    const soloButton = track.querySelector(".solo-btn");
    const volumeSlider = track.querySelector(".track-volume");
    const deleteButton = track.querySelector(".delete-btn");

    armButton.addEventListener("click", () => selectTrack(track));

    muteButton.addEventListener("click", () => {
        const muted = track.dataset.muted !== "true";

        track.dataset.muted = String(muted);
        muteButton.classList.toggle("active", muted);
        muteButton.title = muted ? "Unmute" : "Mute";

        updatePlaybackVolumes();
    });

    soloButton.addEventListener("click", () => {
        const solo = track.dataset.solo !== "true";

        track.dataset.solo = String(solo);
        soloButton.classList.toggle("active", solo);

        updatePlaybackVolumes();
    });

    volumeSlider.addEventListener("input", () => {
        track.dataset.volume = volumeSlider.value;
        updatePlaybackVolumes();
    });

    deleteButton.addEventListener("click", () => {
        if (recordingTrack === track && (isRecording || isCountingIn)) {
            stopRecording();
        }

        if (isPlaying) {
            stopPlayback();
        }

        track.remove();

        if (selectedTrack === track) {
            selectedTrack = null;

            const remainingTrack =
                tracksContainer.querySelector(".track");

            if (remainingTrack) {
                selectTrack(remainingTrack);
            }
        }

        updateMeasureGrid();
    });

    if (!selectedTrack) {
        selectTrack(track);
    }

    updateMeasureGrid();

    return track;
}

function selectTrack(track) {
    if (isRecording || isCountingIn) {
        alert("Stop recording before changing the selected track.");
        return;
    }

    selectedTrack = track;

    tracksContainer.querySelectorAll(".track").forEach(item => {
        const selected = item === track;

        item.classList.toggle("selected", selected);
        item.querySelector(".arm-btn").classList.toggle(
            "active",
            selected
        );
    });
}


// --------------------------------------------------
// MICROPHONE INPUT
// --------------------------------------------------

async function getMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
            "Microphone access is unavailable. Open the site through localhost in Chrome."
        );
    }

    let constraints = { audio: true };

    if (inputDevice?.value) {
        constraints = {
            audio: {
                deviceId: { exact: inputDevice.value }
            }
        };
    }

    try {
        return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
        if (constraints.audio !== true) {
            return await navigator.mediaDevices.getUserMedia({
                audio: true
            });
        }

        throw error;
    }
}

async function loadInputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true
        });

        stream.getTracks().forEach(track => track.stop());

        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(
            device => device.kind === "audioinput"
        );

        if (!inputDevice) return;

        const previousValue = inputDevice.value;
        inputDevice.innerHTML = "";

        audioInputs.forEach((device, index) => {
            const option = document.createElement("option");

            option.value = device.deviceId;
            option.textContent =
                device.label || `Microphone ${index + 1}`;

            inputDevice.appendChild(option);
        });

        if (
            previousValue &&
            audioInputs.some(device => device.deviceId === previousValue)
        ) {
            inputDevice.value = previousValue;
        }
    } catch (error) {
        console.warn("Could not list audio inputs:", error);
    }
}


// --------------------------------------------------
// WAVEFORM
// --------------------------------------------------

function createWaveform(audioBuffer, color) {
    const canvas = document.createElement("canvas");
    canvas.className = "waveform-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";

    const width = 1200;
    const height = 90;

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    const samples = audioBuffer.getChannelData(0);
    const samplesPerBar = Math.max(
        1,
        Math.floor(samples.length / width)
    );

    context.clearRect(0, 0, width, height);
    context.fillStyle = color;

    for (let x = 0; x < width; x++) {
        const start = x * samplesPerBar;
        let peak = 0;

        for (
            let i = start;
            i < Math.min(start + samplesPerBar, samples.length);
            i++
        ) {
            peak = Math.max(peak, Math.abs(samples[i]));
        }

        const barHeight = Math.max(2, peak * height * 0.9);

        context.fillRect(
            x,
            (height - barHeight) / 2,
            1,
            barHeight
        );
    }

    return canvas;
}

function displayRecording(track, audioBuffer) {
    const lane = track.querySelector(".track-lane");

    lane.innerHTML = "";

    lane.appendChild(
        createWaveform(audioBuffer, track.dataset.color)
    );

    // Restore ruler and playhead after replacing the lane contents.
    updateMeasureGrid();
}


// --------------------------------------------------
// METRONOME
// --------------------------------------------------

function playMetronomeClick(time, accented = false) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = accented ? 1500 : 1000;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(
        accented ? 0.3 : 0.18,
        time + 0.005
    );
    gain.gain.exponentialRampToValueAtTime(
        0.0001,
        time + 0.055
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(time);
    oscillator.stop(time + 0.06);
}

function startMetronome() {
    stopMetronome();

    if (!metronomeEnabled?.checked) return;

    let beatNumber = 0;
    nextClickTime = audioContext.currentTime + 0.03;

    metronomeScheduler = setInterval(() => {
        const lookAhead = audioContext.currentTime + 0.1;
        const beatDuration = 60 / getBpm();

        while (nextClickTime < lookAhead) {
            playMetronomeClick(
                nextClickTime,
                beatNumber % 4 === 0
            );

            beatNumber++;
            nextClickTime += beatDuration;
        }
    }, 25);
}

function stopMetronome() {
    if (metronomeScheduler !== null) {
        clearInterval(metronomeScheduler);
        metronomeScheduler = null;
    }
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runCountIn(token) {
    const beatDuration = 60000 / getBpm();

    for (let beat = 4; beat >= 1; beat--) {
        if (token !== countdownToken) return false;

        updateTimerDisplay(String(beat));

        timeDisplay?.classList.add("countdown-display");

        await sleep(beatDuration);
    }

    timeDisplay?.classList.remove("countdown-display");

    return token === countdownToken;
}


// --------------------------------------------------
// RECORDING
// --------------------------------------------------

async function startRecording() {
    if (isRecording || isCountingIn) return;

    if (!selectedTrack || !selectedTrack.isConnected) {
        alert("Select a track using its ARM button first.");
        return;
    }

    if (selectedTrack.dataset.muted === "true") {
        alert("Unmute the selected track before recording.");
        return;
    }

    if (isPlaying) {
        stopPlayback();
    }

    const targetTrack = selectedTrack;
    const token = ++countdownToken;

    recordingTrack = targetTrack;
    isCountingIn = true;

    try {
        await audioContext.resume();

        const stream = await getMicrophone();

        if (token !== countdownToken) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        recordingStream = stream;

        startMetronome();

        const countdownFinished = await runCountIn(token);

        if (!countdownFinished) {
            stream.getTracks().forEach(track => track.stop());

            if (recordingStream === stream) {
                recordingStream = null;
            }

            return;
        }

        const supportedTypes = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/mp4"
        ];

        const mimeType = supportedTypes.find(type =>
            MediaRecorder.isTypeSupported(type)
        );

        const recorder = mimeType
            ? new MediaRecorder(stream, { mimeType })
            : new MediaRecorder(stream);

        activeRecorder = recorder;
        recordingChunks = [];

        recorder.addEventListener("dataavailable", event => {
            if (event.data.size > 0) {
                recordingChunks.push(event.data);
            }
        });

        recorder.addEventListener("stop", async () => {
            try {
                if (recordingChunks.length === 0) return;

                const blob = new Blob(recordingChunks, {
                    type: recorder.mimeType || "audio/webm"
                });

                const arrayBuffer = await blob.arrayBuffer();
                const audioBuffer =
                    await audioContext.decodeAudioData(arrayBuffer);

                targetTrack._audioBuffer = audioBuffer;
                targetTrack._audioBlob = blob;

                displayRecording(targetTrack, audioBuffer);
            } catch (error) {
                console.error("Could not process recording:", error);
                alert("The recording could not be processed.");
            } finally {
                stream.getTracks().forEach(track => track.stop());

                if (recordingStream === stream) {
                    recordingStream = null;
                }

                if (activeRecorder === recorder) {
                    activeRecorder = null;
                }

                if (recordingTrack === targetTrack) {
                    recordingTrack = null;
                }

                targetTrack.querySelector(".track-name").style.color = "";
            }
        });

        recorder.start();

        isCountingIn = false;
        isRecording = true;

        recordBtn?.classList.add("recording");

        targetTrack.querySelector(".track-name").style.color = "#c74b3c";

        elapsedSeconds = 0;
        updateTimerDisplay();
        startClock();

        // Move the playhead across the selected number of measures.
        const recordingDuration = getProjectDuration();

        startPlayhead(recordingDuration);

        // Automatically stop at the end of the final measure.
        recordingLimitTimeout = setTimeout(() => {
            recordingLimitTimeout = null;

            if (isRecording) {
                stopRecording();
            }
        }, recordingDuration * 1000);

    } catch (error) {
        console.error("Recording error:", error);

        alert(
            "Could not start recording. Check microphone permission and your input device."
        );

        isCountingIn = false;
        isRecording = false;
        recordingTrack = null;

        if (recordingStream) {
            recordingStream.getTracks().forEach(track => track.stop());
            recordingStream = null;
        }

        stopMetronome();
        stopPlayhead();

        recordBtn?.classList.remove("recording");
        timeDisplay?.classList.remove("countdown-display");

        updateTimerDisplay();
    }
}

function stopRecording() {
    countdownToken++;
    isCountingIn = false;

    if (recordingLimitTimeout !== null) {
        clearTimeout(recordingLimitTimeout);
        recordingLimitTimeout = null;
    }

    stopMetronome();
    stopPlayhead();

    if (activeRecorder && activeRecorder.state !== "inactive") {
        activeRecorder.stop();
    } else {
        recordingTrack = null;

        if (recordingStream) {
            recordingStream.getTracks().forEach(track => track.stop());
            recordingStream = null;
        }
    }

    isRecording = false;

    recordBtn?.classList.remove("recording");
    timeDisplay?.classList.remove("countdown-display");

    if (recordingTrack?.isConnected) {
        recordingTrack.querySelector(".track-name").style.color = "";
    }

    if (!isPlaying) {
        stopClock();
    }

    updateTimerDisplay();
}


// --------------------------------------------------
// PLAYBACK AND MIXING
// --------------------------------------------------

function updatePlaybackVolumes() {
    const tracks = Array.from(
        tracksContainer.querySelectorAll(".track")
    );

    const hasSolo = tracks.some(
        track => track.dataset.solo === "true"
    );

    tracks.forEach((track, index) => {
        const muted = track.dataset.muted === "true";
        const solo = track.dataset.solo === "true";

        const shouldPlay = !muted && (!hasSolo || solo);
        const volume = Number(track.dataset.volume ?? 0.8);

        if (playbackGains[index]) {
            playbackGains[index].gain.value =
                shouldPlay ? volume : 0;
        }
    });
}

function playTracks() {
    if (isPlaying || isRecording || isCountingIn) return;

    const tracks = Array.from(
        tracksContainer.querySelectorAll(".track")
    );

    const tracksWithAudio = tracks.filter(
        track => track._audioBuffer
    );

    if (tracksWithAudio.length === 0) {
        alert("Record some audio before pressing play.");
        return;
    }

    audioContext.resume();

    playbackSources = [];
    playbackGains = [];

    const hasSolo = tracks.some(
        track => track.dataset.solo === "true"
    );

    let longestDuration = 0;

    tracks.forEach(track => {
        const buffer = track._audioBuffer;

        if (!buffer) {
            playbackGains.push(null);
            return;
        }

        longestDuration = Math.max(longestDuration, buffer.duration);

        const source = audioContext.createBufferSource();
        const gain = audioContext.createGain();

        const muted = track.dataset.muted === "true";
        const solo = track.dataset.solo === "true";
        const shouldPlay = !muted && (!hasSolo || solo);

        gain.gain.value = shouldPlay
            ? Number(track.dataset.volume ?? 0.8)
            : 0;

        source.buffer = buffer;
        source.connect(gain);
        gain.connect(audioContext.destination);

        playbackSources.push(source);
        playbackGains.push(gain);
    });

    if (longestDuration <= 0) return;

    isPlaying = true;
    elapsedSeconds = 0;

    playbackStartedAt = audioContext.currentTime;

    updateTimerDisplay();
    startClock();
    startPlayhead(longestDuration);

    playBtn?.classList.add("playing");

    // Start all tracks at the same audio-clock time.
    const startAt = audioContext.currentTime + 0.03;

    playbackSources.forEach(source => {
        source.start(startAt);
    });

    playbackEndTimeout = setTimeout(() => {
        playbackEndTimeout = null;

        if (isPlaying) {
            stopPlayback();
        }
    }, longestDuration * 1000 + 100);
}

function stopPlayback() {
    if (playbackEndTimeout !== null) {
        clearTimeout(playbackEndTimeout);
        playbackEndTimeout = null;
    }

    playbackSources.forEach(source => {
        try {
            source.stop();
        } catch (error) {
            // Source may already have stopped.
        }
    });

    playbackSources = [];
    playbackGains = [];

    isPlaying = false;

    playBtn?.classList.remove("playing");

    stopPlayhead();

    if (!isRecording) {
        stopClock();
    }

    elapsedSeconds = 0;
    updateTimerDisplay();
}


// --------------------------------------------------
// BUTTONS AND INITIAL SETUP
// --------------------------------------------------

recordBtn?.addEventListener("click", () => {
    if (isRecording || isCountingIn) {
        stopRecording();
    } else {
        startRecording();
    }
});

playBtn?.addEventListener("click", playTracks);

stopBtn?.addEventListener("click", () => {
    stopRecording();
    stopPlayback();

    stopClock();

    elapsedSeconds = 0;
    updateTimerDisplay();
});

addTrackBtn?.addEventListener("click", () => {
    addTrack();
});

// Create initial tracks.
addTrack("GUITAR L");
addTrack("GUITAR R");
addTrack("VOCALS");
addTrack("ROOM MIC");

// Prepare microphone selection.
loadInputDevices();

if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener(
        "devicechange",
        loadInputDevices
    );
}

// Initial grid and playhead.
updateMeasureGrid();
updatePlayheadElements();
updateTimerDisplay();
