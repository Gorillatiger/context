// Context local speech helper. MIT. No sockets, recordings, or transcript files.
#include "whisper.h"
#include "ggml-backend.h"
#include "json.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <regex>
#include <string>
#include <thread>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr size_t RATE = 16000, VAD_FRAME = 512;
constexpr size_t MAX_AUDIO = RATE * 180, WINDOW = RATE * 24, OVERLAP = RATE * 3 / 5;
constexpr size_t MAX_FRAME = 1 + 36 + RATE * sizeof(float), MAX_QUEUE_AUDIO = RATE * 3;
std::mutex output_mutex;

double millis(Clock::time_point a, Clock::time_point b = Clock::now()) {
    return std::chrono::duration<double, std::milli>(b - a).count();
}
uint64_t peak_rss() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS info{};
    return GetProcessMemoryInfo(GetCurrentProcess(), &info, sizeof(info)) ? info.PeakWorkingSetSize : 0;
#else
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) != 0) return 0;
#ifdef __APPLE__
    return usage.ru_maxrss;
#else
    return static_cast<uint64_t>(usage.ru_maxrss) * 1024;
#endif
#endif
}
void wipe(std::vector<float> & data) {
    volatile float * p = data.data();
    for (size_t i = 0; i < data.size(); ++i) p[i] = 0;
    data.clear();
}
void wipe(std::string & data) {
    volatile char * p = data.data();
    for (size_t i = 0; i < data.size(); ++i) p[i] = 0;
    data.clear();
}
void emit(json event) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << event.dump(-1, ' ', false, json::error_handler_t::replace) << '\n' << std::flush;
}
void error(const std::string & code, const std::string & message, const std::string & id = "") {
    json value{{"event", "error"}, {"code", code}, {"message", message}};
    if (!id.empty()) value["id"] = id;
    emit(value);
}
bool valid_id(const std::string & id) {
    static const std::regex pattern("^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$");
    return std::regex_match(id, pattern);
}
std::string trim(std::string text) {
    const auto first = text.find_first_not_of(" \t\n\r");
    if (first == std::string::npos) return "";
    return text.substr(first, text.find_last_not_of(" \t\n\r") - first + 1);
}
std::string join_text(const std::string & a, const std::string & b) {
    if (a.empty()) return trim(b);
    if (b.empty()) return a;
    // Whisper returns BPE word pieces. Preserve all intra-window pieces; only
    // normalize the boundary between independently owned audio intervals.
    const auto tail = trim(b);
    if (tail.empty()) return a;
    return a + (std::string(".,;:!?)]}").find(tail[0]) != std::string::npos ? "" : " ") + tail;
}
struct Session {
    std::string id;
    std::atomic<bool> cancelled{false}, final_requested{false};
    std::atomic<int> terminal{0}; // 0active, 1final, 2cancelled: exactly one terminal event.
    std::mutex audio_mutex;
    std::vector<float> audio;
    std::vector<float> preroll;
    std::vector<float> pending_pcm;
    size_t total_samples = 0, last_voice_sample = 0;
    std::atomic<size_t> voiced_samples{0};
    size_t next_interim = RATE * 3 / 2;
    int pause_ms = 1800, interim_ms = 1500;
    float threshold = 0.5f;
    bool has_voice = false;
    Clock::time_point start = Clock::now(), last_voice = start, processing_started = start;
    std::string reason;
    // The inference thread alone owns the following fields.
    size_t committed_until = 0;
    std::string committed_text;
    double inference_ms = 0;
    ~Session() { wipe(audio); wipe(preroll); wipe(pending_pcm); wipe(committed_text); }
};
struct Packet {
    json command;
    std::string id;
    std::vector<float> pcm;
};
struct Job {
    json load;
    std::shared_ptr<Session> session;
    bool final = false;
    Clock::time_point load_started = Clock::now();
};

class Engine {
    std::atomic<bool> shutdown_{false}, ready_{false};
    std::mutex queue_mutex_, jobs_mutex_, active_mutex_;
    std::condition_variable queue_cv_, jobs_cv_;
    std::deque<Packet> queue_;
    std::deque<Job> jobs_;
    size_t queued_audio_ = 0;
    std::shared_ptr<Session> active_;
    std::thread audio_thread_, inference_thread_;
    whisper_vad_context * vad_ = nullptr;
    whisper_context * whisper_ = nullptr;
    std::string model_path_, backend_ = "cpu";
    std::atomic<int> threads_{4};
    double load_ms_ = 0;
    Clock::time_point last_vad_event_{};

    std::shared_ptr<Session> active() {
        std::lock_guard<std::mutex> lock(active_mutex_);
        return active_;
    }
    void cancel_session(const std::shared_ptr<Session> & s, bool announce = true) {
        if (!s) return;
        int expected = 0;
        if (!s->terminal.compare_exchange_strong(expected, 2)) return;
        s->cancelled = true;
        {
            std::lock_guard<std::mutex> lock(s->audio_mutex);
            wipe(s->audio); wipe(s->preroll); wipe(s->pending_pcm);
        }
        {
            std::lock_guard<std::mutex> lock(jobs_mutex_);
            jobs_.erase(std::remove_if(jobs_.begin(), jobs_.end(), [&](const Job & job) { return job.session == s; }), jobs_.end());
        }
        if (announce) emit({{"event", "cancelled"}, {"id", s->id}});
    }
    void enqueue_job(Job job) {
        std::lock_guard<std::mutex> lock(jobs_mutex_);
        // Coalesce intermediate requests instead of accumulating old inference
        // work when CPU transcription is slower than the audio stream.
        if (job.session) {
            jobs_.erase(std::remove_if(jobs_.begin(), jobs_.end(), [&](const Job & old) { return old.session == job.session && !old.final; }), jobs_.end());
        }
        if (job.final || !job.load.is_null()) jobs_.push_front(std::move(job));
        else jobs_.push_back(std::move(job));
        jobs_cv_.notify_one();
    }
    void finish(const std::shared_ptr<Session> & s, const std::string & reason) {
        if (!s || s->cancelled.load() || s->final_requested.exchange(true)) return;
        s->reason = reason;
        s->processing_started = Clock::now();
        emit({{"event", "processing"}, {"id", s->id}, {"reason", reason}});
        enqueue_job(Job{json{}, s, true});
    }
    void load(const json & command) {
        const auto started = Clock::now();
        ready_ = false;
        cancel_session(active());
        if (vad_) { whisper_vad_free(vad_); vad_ = nullptr; }
        const auto vad_path = command.value("vadPath", std::string());
        if (vad_path.empty() || command.value("modelPath", std::string()).empty()) {
            error("MODEL_PATH", "Die Sprachmodelle fehlen."); return;
        }
        threads_ = std::clamp(command.value("threads", 4), 1, 8);
        auto params = whisper_vad_default_context_params();
        params.use_gpu = false; params.n_threads = std::min(threads_.load(), 2);
        vad_ = whisper_vad_init_from_file_with_params(vad_path.c_str(), params);
        if (!vad_) { error("VAD_LOAD", "Silero VAD konnte nicht geladen werden."); return; }
        enqueue_job(Job{command, nullptr, false, started});
    }
    void start(const json & command) {
        const auto id = command.value("id", std::string());
        if (!valid_id(id)) { error("SESSION_ID", "Ungültige Aufnahme-ID."); return; }
        if (!ready_ || !vad_) { error("MODEL_NOT_READY", "Das Sprachmodell ist noch nicht bereit.", id); return; }
        auto old = active();
        if (old && old->id == id) { error("SESSION_DUPLICATE", "Diese Aufnahme wurde bereits gestartet.", id); return; }
        cancel_session(old);
        auto s = std::make_shared<Session>(); s->id = id;
        s->pause_ms = std::clamp(command.value("pauseMs", 1800), 600, 5000);
        s->interim_ms = std::clamp(command.value("interimMs", 1500), 750, 5000);
        s->threshold = std::clamp(command.value("threshold", 0.5f), 0.2f, 0.9f);
        s->next_interim = RATE * s->interim_ms / 1000;
        s->audio.reserve(RATE * 30); s->preroll.reserve(RATE / 2);
        whisper_vad_reset_state(vad_);
        { std::lock_guard<std::mutex> lock(active_mutex_); active_ = s; }
        emit({{"event", "started"}, {"id", id}, {"pauseMs", s->pause_ms}, {"sampleRate", RATE}});
    }
    void audio(Packet & packet) {
        auto s = active();
        if (!s || s->id != packet.id || s->cancelled || s->final_requested) { wipe(packet.pcm); return; }
        {
            std::lock_guard<std::mutex> lock(s->audio_mutex);
            if (!s->pending_pcm.empty()) {
                std::vector<float> combined;
                combined.reserve(s->pending_pcm.size() + packet.pcm.size());
                combined.insert(combined.end(), s->pending_pcm.begin(), s->pending_pcm.end());
                combined.insert(combined.end(), packet.pcm.begin(), packet.pcm.end());
                wipe(s->pending_pcm); wipe(packet.pcm); packet.pcm = std::move(combined);
            }
        }
        // IPC chunks may end mid-frame. Only Silero receives exact512-sample
        // frames; retain the tail and zero-pad it on manual stop.
        size_t offset = 0;
        for (; offset + VAD_FRAME <= packet.pcm.size(); offset += VAD_FRAME) {
            if (s->cancelled || s->final_requested || shutdown_) break;
            const float * frame = packet.pcm.data() + offset;
            if (!whisper_vad_detect_speech_no_reset(vad_, frame, VAD_FRAME) || whisper_vad_n_probs(vad_) < 1) {
                error("VAD_PROCESS", "Die Spracherkennung musste die Aufnahme abbrechen.", s->id);
                cancel_session(s); break;
            }
            const float probability = whisper_vad_probs(vad_)[0];
            if (!std::isfinite(probability)) {
                error("VAD_PROCESS", "Die Spracherkennung musste die Aufnahme abbrechen.", s->id);
                cancel_session(s); break;
            }
            s->total_samples += VAD_FRAME;
            const bool voice = probability >= s->threshold;
            if (voice) {
                s->voiced_samples += VAD_FRAME;
                s->last_voice_sample = s->total_samples; s->last_voice = Clock::now();
            }
            {
                std::lock_guard<std::mutex> lock(s->audio_mutex);
                if (s->cancelled) break;
                if (!s->has_voice && voice) {
                    s->has_voice = true;
                    s->audio.insert(s->audio.end(), s->preroll.begin(), s->preroll.end());
                    wipe(s->preroll);
                }
                if (s->has_voice) {
                    if (s->audio.size() + VAD_FRAME <= MAX_AUDIO) s->audio.insert(s->audio.end(), frame, frame + VAD_FRAME);
                } else {
                    s->preroll.insert(s->preroll.end(), frame, frame + VAD_FRAME);
                    if (s->preroll.size() > RATE * 2 / 5) s->preroll.erase(s->preroll.begin(), s->preroll.end() - RATE * 2 / 5);
                }
            }
            if (millis(last_vad_event_) > 100) {
                double sum = 0;
                for (size_t i = 0; i < VAD_FRAME; ++i) sum += frame[i] * frame[i];
                if (!s->cancelled) emit({{"event", "vad"}, {"id", s->id}, {"probability", probability}, {"speech", voice}, {"speaking", voice}, {"inputMs", s->total_samples * 1000 / RATE}, {"level", std::sqrt(sum / VAD_FRAME)}});
                last_vad_event_ = Clock::now();
            }
            if (s->has_voice && s->voiced_samples >= RATE / 4 && s->total_samples >= s->next_interim) {
                s->next_interim = s->total_samples + RATE * s->interim_ms / 1000;
                enqueue_job(Job{json{}, s, false});
            }
            if (s->has_voice && s->total_samples - s->last_voice_sample >= RATE * s->pause_ms / 1000) finish(s, "pause");
            else if (!s->has_voice && s->total_samples >= RATE * 15) finish(s, "no-speech");
            else if (s->total_samples >= MAX_AUDIO) finish(s, "duration-limit");
        }
        {
            std::lock_guard<std::mutex> lock(s->audio_mutex);
            if (!s->cancelled && !s->final_requested && offset < packet.pcm.size()) s->pending_pcm.assign(packet.pcm.begin() + offset, packet.pcm.end());
        }
        wipe(packet.pcm);
    }
    void stop(const std::shared_ptr<Session> & s) {
        if (!s || s->cancelled || s->final_requested) return;
        Packet tail; tail.id = s->id;
        {
            std::lock_guard<std::mutex> lock(s->audio_mutex);
            if (!s->pending_pcm.empty()) {
                tail.pcm = std::move(s->pending_pcm);
                tail.pcm.resize(VAD_FRAME, 0.0f);
            }
        }
        if (!tail.pcm.empty()) audio(tail);
        finish(s, "stop");
    }
    void audio_loop() {
        while (!shutdown_) {
            Packet packet;
            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                queue_cv_.wait(lock, [&] { return shutdown_ || !queue_.empty(); });
                if (shutdown_) break;
                packet = std::move(queue_.front()); queue_.pop_front();
                queued_audio_ -= packet.pcm.size();
            }
            try {
                if (!packet.pcm.empty()) audio(packet);
                else {
                    const auto op = packet.command.value("op", std::string());
                    if (op == "load") load(packet.command);
                    else if (op == "start") start(packet.command);
                    else if (op == "stop") { auto s = active(); if (s && s->id == packet.command.value("id", std::string())) stop(s); }
                    else if (op != "cancel") error("COMMAND", "Unbekannter Sprachbefehl.");
                }
            } catch (...) { error("COMMAND", "Ungültiger Sprachbefehl."); }
        }
        if (vad_) { whisper_vad_free(vad_); vad_ = nullptr; }
    }
    bool init_whisper(bool gpu) {
        if (whisper_) { whisper_free(whisper_); whisper_ = nullptr; }
#ifdef __APPLE__
        if (gpu) {
            bool usable_metal = false;
            for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
                auto device = ggml_backend_dev_get(i);
                const auto registry = ggml_backend_dev_backend_reg(device);
                if (ggml_backend_dev_type(device) != GGML_BACKEND_DEVICE_TYPE_GPU || !registry || std::string(ggml_backend_reg_name(registry)) != "MTL") continue;
                size_t free = 0, total = 0;
                ggml_backend_dev_memory(device, &free, &total);
                // A headless/restricted process may see the MTL registry with a
                // nil Metal device. Upstream1.9.2 then dereferences a failed
                // model-buffer allocation. Avoid that path before model load.
                usable_metal = total > 0 && free >= 64 * 1024 * 1024;
            }
            gpu = usable_metal;
        }
#endif
        auto params = whisper_context_default_params();
        params.use_gpu = gpu; params.flash_attn = true;
        whisper_ = whisper_init_from_file_with_params(model_path_.c_str(), params);
        if (!whisper_) return false;
        if (!whisper_is_multilingual(whisper_)) { whisper_free(whisper_); whisper_ = nullptr; return false; }
#ifdef __APPLE__
        bool metal_available = false;
        for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
            auto device = ggml_backend_dev_get(i);
            const auto registry = ggml_backend_dev_backend_reg(device);
            if (ggml_backend_dev_type(device) == GGML_BACKEND_DEVICE_TYPE_GPU && registry && std::string(ggml_backend_reg_name(registry)) == "MTL") metal_available = true;
        }
        backend_ = gpu && metal_available ? "metal" : "cpu";
#else
        backend_ = "cpu";
#endif
        return true;
    }
    struct AbortState { Engine * engine; std::shared_ptr<Session> session; bool final; };
    static bool abort_inference(void * data) {
        const auto & state = *static_cast<AbortState *>(data);
        return state.engine->shutdown_.load() || state.session->cancelled.load() || (!state.final && state.session->final_requested.load());
    }
    std::string extract(size_t window_start, size_t owned_after, size_t cut) {
        std::string text;
        const int eot = whisper_token_eot(whisper_);
        for (int segment = 0; segment < whisper_full_n_segments(whisper_); ++segment) {
            // Silero filters the input first. This second filter protects against
            // Whisper hallucinations on a brief false-positive background sound.
            if (whisper_full_get_segment_no_speech_prob(whisper_, segment) > 0.8f) continue;
            for (int token = 0; token < whisper_full_n_tokens(whisper_, segment); ++token) {
                auto data = whisper_full_get_token_data(whisper_, segment, token);
                if (data.id >= eot || data.t1 < 0) continue;
                const size_t end = window_start + static_cast<size_t>(data.t1) * RATE / 100;
                // Time ownership, not fuzzy text matching, excludes tokens from
                // the audio overlap. Deliberate repeated words are retained.
                if (end <= owned_after || end > cut) continue;
                const char * piece = whisper_full_get_token_text(whisper_, segment, token);
                if (piece) text += piece;
            }
        }
        return trim(text);
    }
    size_t word_boundary(size_t window_start, size_t owned_after, size_t proposed) {
        const int eot = whisper_token_eot(whisper_);
        size_t previous_end = 0, candidate = 0;
        for (int segment = 0; segment < whisper_full_n_segments(whisper_); ++segment) {
            if (whisper_full_get_segment_no_speech_prob(whisper_, segment) > 0.8f) continue;
            for (int token = 0; token < whisper_full_n_tokens(whisper_, segment); ++token) {
                const auto data = whisper_full_get_token_data(whisper_, segment, token);
                if (data.id >= eot || data.t1 < 0) continue;
                const char * piece = whisper_full_get_token_text(whisper_, segment, token);
                if (piece && (piece[0] == ' ' || piece[0] == '\n') && previous_end > owned_after && previous_end <= proposed) candidate = previous_end;
                previous_end = window_start + static_cast<size_t>(data.t1) * RATE / 100;
            }
        }
        // Use a full-word boundary so German compound words are not split into
        // BPE pieces across two independently decoded windows. If timestamp
        // estimates contain no usable boundary, still advance a bounded window.
        return candidate > owned_after + RATE ? candidate : proposed;
    }
    bool transcribe_window(const std::vector<float> & window, const std::shared_ptr<Session> & s, bool final) {
        auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        params.language = "de"; params.translate = false; params.detect_language = false;
        params.n_threads = threads_; params.no_context = true;
        params.print_special = false; params.print_progress = false;
        params.print_realtime = false; params.print_timestamps = false;
        params.token_timestamps = true; params.split_on_word = true;
        params.suppress_blank = true; params.suppress_nst = true;
        params.temperature = 0.0f; params.temperature_inc = 0.0f;
        AbortState abort{this, s, final};
        params.abort_callback = abort_inference; params.abort_callback_user_data = &abort;
        const auto started = Clock::now();
        int result = whisper_full(whisper_, params, window.data(), static_cast<int>(window.size()));
        if (result != 0 && !abort_inference(&abort) && backend_ != "cpu") {
            emit({{"event", "backend"}, {"id", s->id}, {"backend", "cpu"}, {"fallback", true}});
            if (init_whisper(false)) result = whisper_full(whisper_, params, window.data(), static_cast<int>(window.size()));
        }
        s->inference_ms += millis(started);
        if (abort_inference(&abort)) return false;
        if (result != 0) {
            error("WHISPER_PROCESS", "Der Beitrag konnte nicht transkribiert werden. Bitte starte erneut.", s->id);
            cancel_session(s); return false;
        }
        return true;
    }
    void infer(const Job & job) {
        auto s = job.session;
        if (!s || s->cancelled || (!job.final && s->final_requested) || !whisper_) return;
        size_t target;
        { std::lock_guard<std::mutex> lock(s->audio_mutex); target = s->audio.size(); }
        std::string preview = s->committed_text;
        while (s->committed_until < target && s->voiced_samples >= RATE / 4 && !s->cancelled && !shutdown_) {
            const size_t start = s->committed_until > OVERLAP ? s->committed_until - OVERLAP : 0;
            const size_t end = std::min(start + WINDOW, target);
            std::vector<float> window;
            {
                std::lock_guard<std::mutex> lock(s->audio_mutex);
                if (s->cancelled || end > s->audio.size()) break;
                window.assign(s->audio.begin() + start, s->audio.begin() + end);
            }
            // Very short voiced bursts still get one second of zero-padding,
            // entirely in RAM, as required by Whisper's minimum input length.
            if (window.size() < RATE) window.resize(RATE, 0.0f);
            const bool ok = transcribe_window(window, s, job.final);
            wipe(window);
            if (!ok) return;
            const bool commit = end < target || end - start >= WINDOW;
            if (commit) {
                const size_t cut = word_boundary(start, s->committed_until, start + RATE * 20);
                auto text = extract(start, s->committed_until, cut);
                s->committed_text = join_text(s->committed_text, text);
                wipe(text);
                s->committed_until = cut;
                preview = s->committed_text;
                continue;
            }
            auto text = extract(start, s->committed_until, target + RATE);
            preview = join_text(s->committed_text, text); wipe(text);
            if (job.final) { s->committed_text = preview; s->committed_until = target; }
            break;
        }
        if (s->cancelled || shutdown_ || (!job.final && s->final_requested)) { wipe(preview); return; }
        const json metrics{{"loadMs", load_ms_}, {"inferenceMs", s->inference_ms},
            {"endToFinalMs", job.final && s->has_voice ? millis(s->last_voice) : 0},
            {"silenceDecisionToFinalMs", job.final ? millis(s->processing_started) : 0},
            {"peakRssBytes", peak_rss()}, {"backend", backend_}, {"audioMs", target * 1000 / RATE}};
        if (job.final) {
            int expected = 0;
            if (!s->terminal.compare_exchange_strong(expected, 1)) { wipe(preview); return; }
            emit({{"event", "final"}, {"id", s->id}, {"text", preview}, {"reason", s->reason}, {"metrics", metrics}});
            { std::lock_guard<std::mutex> lock(s->audio_mutex); wipe(s->audio); wipe(s->preroll); wipe(s->pending_pcm); }
            wipe(s->committed_text);
        } else emit({{"event", "interim"}, {"id", s->id}, {"text", preview}, {"metrics", metrics}});
        wipe(preview);
    }
    void inference_loop() {
        while (!shutdown_) {
            Job job;
            {
                std::unique_lock<std::mutex> lock(jobs_mutex_);
                jobs_cv_.wait(lock, [&] { return shutdown_ || !jobs_.empty(); });
                if (shutdown_) break;
                job = std::move(jobs_.front()); jobs_.pop_front();
            }
            try {
                if (!job.load.is_null()) {
                    model_path_ = job.load.value("modelPath", std::string());
                    bool gpu = false;
#ifdef __APPLE__
                    gpu = job.load.value("gpu", std::string("auto")) != "cpu";
#endif
                    bool fallback = false, ok = init_whisper(gpu);
                    if (!ok && gpu && !shutdown_) { fallback = true; ok = init_whisper(false); }
                    load_ms_ = millis(job.load_started);
                    fallback = fallback || (gpu && backend_ == "cpu");
                    if (!ok) error("WHISPER_LOAD", "Das mehrsprachige Whisper-Modell konnte nicht geladen werden.");
                    else if (!shutdown_) {
                        ready_ = true;
                        emit({{"event", "ready"}, {"backend", backend_}, {"fallback", fallback},
                            {"version", whisper_version()}, {"metrics", {{"loadMs", load_ms_}, {"peakRssBytes", peak_rss()}}}});
                    }
                } else infer(job);
            } catch (...) {
                if (job.session) { error("WHISPER_PROCESS", "Die lokale Verarbeitung wurde abgebrochen.", job.session->id); cancel_session(job.session); }
                else error("WHISPER_LOAD", "Das Sprachmodell konnte nicht geladen werden.");
            }
        }
        if (whisper_) { whisper_free(whisper_); whisper_ = nullptr; }
    }
public:
    Engine() { audio_thread_ = std::thread(&Engine::audio_loop, this); inference_thread_ = std::thread(&Engine::inference_loop, this); }
    ~Engine() { shutdown(); }
    void command(json value) {
        const auto op = value.value("op", std::string());
        if (op == "shutdown") { shutdown(); return; }
        if (op == "cancel") {
            auto s = active();
            if (s && s->id == value.value("id", std::string())) cancel_session(s);
            return;
        }
        std::lock_guard<std::mutex> lock(queue_mutex_);
        if (queue_.size() >= 96) { error("INPUT_OVERFLOW", "Zu viele Sprachbefehle."); return; }
        queue_.push_back(Packet{value, "", {}}); queue_cv_.notify_one();
    }
    void pcm(std::string id, std::vector<float> data) {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        if (queued_audio_ + data.size() > MAX_QUEUE_AUDIO || queue_.size() >= 96) {
            wipe(data);
            auto s = active(); if (s && s->id == id) cancel_session(s);
            error("AUDIO_OVERFLOW", "Das Gerät verarbeitet das Mikrofon zu langsam. Bitte starte erneut.", id); return;
        }
        queued_audio_ += data.size(); queue_.push_back(Packet{json{}, std::move(id), std::move(data)}); queue_cv_.notify_one();
    }
    void shutdown() {
        if (shutdown_.exchange(true)) return;
        cancel_session(active(), false);
        queue_cv_.notify_all(); jobs_cv_.notify_all();
        if (audio_thread_.joinable()) audio_thread_.join();
        if (inference_thread_.joinable()) inference_thread_.join();
        for (auto & packet : queue_) wipe(packet.pcm);
        queue_.clear(); jobs_.clear();
    }
};

bool read_exact(char * target, size_t size) {
    std::cin.read(target, static_cast<std::streamsize>(size));
    return static_cast<size_t>(std::cin.gcount()) == size;
}
uint32_t little_u32(const unsigned char * p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
int main() {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
#endif
    // Never print model diagnostics that might eventually include decoded text.
    const bool diagnostics = std::getenv("CONTEXT_SPEECH_DIAGNOSTICS") != nullptr;
    const auto log = [](ggml_log_level, const char * text, void * enabled) { if (enabled) std::fputs(text, stderr); };
    whisper_log_set(log, diagnostics ? reinterpret_cast<void *>(1) : nullptr);
    ggml_log_set(log, diagnostics ? reinterpret_cast<void *>(1) : nullptr);
    Engine engine;
    while (true) {
        unsigned char header[4];
        if (!read_exact(reinterpret_cast<char *>(header), sizeof(header))) break;
        const size_t size = little_u32(header);
        if (size < 2 || size > MAX_FRAME) { error("PROTOCOL_SIZE", "Ungültige Audio-Nachricht."); break; }
        std::vector<unsigned char> payload(size);
        if (!read_exact(reinterpret_cast<char *>(payload.data()), size)) { error("PROTOCOL_TRUNCATED", "Die Aufnahmeverbindung wurde unterbrochen."); break; }
        if (payload[0] == 1 && size <= 8193) {
            try {
                auto command = json::parse(reinterpret_cast<const char *>(payload.data() + 1), reinterpret_cast<const char *>(payload.data() + payload.size()));
                if (!command.is_object()) throw std::runtime_error("object required");
                const bool quit = command.value("op", std::string()) == "shutdown";
                engine.command(std::move(command));
                if (quit) break;
            } catch (...) { error("PROTOCOL_JSON", "Ungültiger Sprachbefehl."); }
        } else if (payload[0] == 2 && size >= 41 && (size - 37) % sizeof(float) == 0) {
            std::string id(reinterpret_cast<const char *>(payload.data() + 1), 36);
            if (!valid_id(id)) { error("SESSION_ID", "Ungültige Aufnahme-ID."); continue; }
            std::vector<float> pcm((size - 37) / sizeof(float));
            bool valid = !pcm.empty();
            for (size_t i = 0; i < pcm.size(); ++i) {
                const uint32_t bits = little_u32(payload.data() + 37 + i * sizeof(float));
                std::memcpy(&pcm[i], &bits, sizeof(float));
                if (!std::isfinite(pcm[i])) { valid = false; break; }
                pcm[i] = std::clamp(pcm[i], -1.0f, 1.0f);
            }
            std::fill(payload.begin(), payload.end(), 0);
            if (valid) engine.pcm(std::move(id), std::move(pcm));
            else { wipe(pcm); error("PCM_INVALID", "Ungültige Audiodaten.", id); engine.command({{"op", "cancel"}, {"id", id}}); }
        } else error("PROTOCOL_TYPE", "Ungültige Audio-Nachricht.");
        std::fill(payload.begin(), payload.end(), 0);
    }
    engine.shutdown();
    return 0;
}
