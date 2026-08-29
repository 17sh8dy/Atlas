from kokoro import KPipeline
import soundfile as sf

pipeline = KPipeline(lang_code="a")

text = "Hello. I'm Atlas. It's good to meet you. How can I help?"

generator = pipeline(
    text,
    voice="af_heart",
    speed=1.0
)

for i, (gs, ps, audio) in enumerate(generator):
    sf.write(f"atlas_test_{i}.wav", audio, 24000)

print("Done! Audio files created.")