import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('broker', Path(__file__).resolve().parents[1] / 'src/build-broker.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class ContextSecurity(unittest.TestCase):
    def test_rejects_traversal_symlinks_devices_and_duplicates(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('device', tarfile.CHRTYPE), ('duplicate', None)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / 'context.tar'
                destination = root / 'context'
                destination.mkdir()
                with tarfile.open(archive, 'w') as tar:
                    for _ in range(2 if kind is None else 1):
                        item = tarfile.TarInfo(name)
                        item.type = kind or tarfile.REGTYPE
                        item.linkname = '/etc/passwd'
                        tar.addfile(item, io.BytesIO())
                with self.assertRaises(ValueError):
                    broker.extract_context(archive, destination)
                self.assertFalse((root / 'escape').exists())

    def test_preserves_executable_without_setuid_and_never_extracts_host_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'context.tar'
            destination = root / 'context'
            destination.mkdir()
            with tarfile.open(archive, 'w') as tar:
                item = tarfile.TarInfo('bin/tool')
                item.size = 4
                item.mode = 0o4755
                item.uid = 0
                tar.addfile(item, io.BytesIO(b'test'))
            broker.extract_context(archive, destination)
            output = destination / 'bin/tool'
            self.assertEqual(output.read_bytes(), b'test')
            self.assertEqual(output.stat().st_mode & 0o7777, 0o700)


if __name__ == '__main__':
    unittest.main()
